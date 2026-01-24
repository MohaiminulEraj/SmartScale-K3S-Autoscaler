# 🚀 SmartScale K3s Autoscaler (Simplified & Cloud-Adapted)

Automated scaling for K3s clusters on AWS using Pulumi and AWS Lambda. This project provisions a K3s cluster and deploys a serverless autoscaler that manages worker nodes based on CPU load.

**Optimized for Restricted Lab Environments:**
- Uses **t2.micro** (Free Tier) instances.
- Handles **Spot Instance** interruptions.
- Bypasses IAM Instance Profile restrictions via secure S3 token exchange.
- Uses **VPC Endpoints** for secure Lambda-to-AWS communication without NAT Gateways.

## 📂 Project Structure

*   **`infra/` (Pulumi):**
    *   Deploys the VPC, Subnets (Multi-AZ), and Security Groups.
    *   Provisions the K3s Master Node (EC2).
    *   Sets up DynamoDB (State Locking) and S3 (Config/Token storage).
    *   **Deploys the Autoscaler as an AWS Lambda function.**
*   **`autoscaler/` (TypeScript):**
    *   **Core:** Pure logic for scaling decisions (`decision.ts`).
    *   **Adapters:**
        *   `k8s.ts`: Connects to Master API to drain nodes safely.
        *   `ec2.ts`: Launches Spot/On-Demand instances across AZs.
        *   `dynamodb.ts`: Distributed locking and state tracking.
    *   Built and uploaded by Pulumi to run as a Lambda function.

## 🛠️ Setup & Deployment

### 1. Prerequisites
*   **AWS Credentials:** You need an `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`.
*   **Tools:** Pulumi CLI and Node.js installed.

### 2. Build & Deploy
Since the autoscaler is deployed as a Lambda function, it must be compiled **before** deploying the infrastructure.

```bash
# 1. Build the Autoscaler
cd autoscaler
npm install
npm run build

# 2. Deploy Infrastructure
cd ../infra
npm install
export AWS_REGION=ap-southeast-1
pulumi up
```

### 3. Manual Bootstrap (Required)
Due to lab restrictions preventing automatic IAM Role attachment, you must manually upload the cluster tokens to S3 so the Autoscaler can access them.

1.  **SSH into the Master Node:**
    *   Use the `k3s-key.pem` generated during deployment.
    *   IP Address is in the Pulumi stack output (`masterPublicIp`).
    ```bash
    chmod 600 k3s-key.pem
    ssh -i k3s-key.pem ubuntu@<MASTER_IP>
    ```

2.  **Configure Credentials & Upload Tokens:**
    *   Run `aws configure` (use your credentials).
    *   Run the following commands to upload the Join Token and generate an API Token:

    ```bash
    # Upload Join Token
    sudo cp /var/lib/rancher/k3s/server/node-token /tmp/node-token
    sudo chown ubuntu:ubuntu /tmp/node-token
    aws s3 cp /tmp/node-token s3://<CONFIG_BUCKET_NAME>/node-token

    # Install Helm (for Monitoring)
    curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3
    chmod 700 get_helm.sh
    ./get_helm.sh

    # Install Prometheus
    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
    helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
    helm repo update
    helm install monitoring prometheus-community/kube-prometheus-stack \
      --namespace monitoring --create-namespace \
      --set prometheus.service.type=NodePort \
      --set prometheus.service.nodePort=30090 \
      --set grafana.enabled=false \
      --set alertmanager.enabled=false

    # Generate & Upload API Token
    # Ensure service account exists (ignore if already exists)
    sudo /usr/local/bin/k3s kubectl create serviceaccount autoscaler -n kube-system
    sudo /usr/local/bin/k3s kubectl create clusterrolebinding autoscaler-admin --clusterrole=cluster-admin --serviceaccount=kube-system:autoscaler
    
    # Generate token
    TOKEN=$(sudo /usr/local/bin/k3s kubectl create token autoscaler -n kube-system --duration=8760h)
    echo "$TOKEN" > api-token
    aws s3 cp api-token s3://<CONFIG_BUCKET_NAME>/api-token
    ```

## 🧠 How It Works

*   **Autoscaling:** An AWS Lambda function (triggered manually or via schedule if permissions allow).
    *   **Scale Up:** If CPU > 70% or Pending Pods > 0, a new EC2 worker is launched. It pulls the token from S3 and joins the cluster automatically.
    *   **Scale Down:** If CPU < 30% and 0 Pending Pods, the oldest worker node is:
        1.  **Cordoned & Drained** via K8s API.
        2.  **Terminated** via EC2 API.
    *   **Spot Interruptions:** If a Spot instance is reclaimed, the Autoscaler detects the event, drains the node immediately, and launches a replacement.

## 🧪 Testing
1.  Go to the AWS Lambda Console.
2.  Select the `k3s-autoscaler` function.
3.  Create a test event (empty JSON `{}`) and click **Test**.
4.  View the logs to see the scaling decision (`NOOP`, `SCALE_UP`, etc.).

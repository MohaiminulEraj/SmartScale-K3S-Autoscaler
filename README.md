# 🚀 SmartScale K3s Autoscaler

This project implements a custom autoscaler for K3s on AWS. It consists of an Infrastructure-as-Code stack to provision the cluster environment and a Node.js application that acts as the autoscaling controller.

## 📂 Project Structure

*   **`infra/` (Pulumi):**
    *   Provisions the AWS Virtual Private Cloud (VPC) and Networking.
    *   Deploys the K3s Master Node (EC2).
    *   Creates a DynamoDB table for state management.
    *   Creates an S3 bucket for secure K3s token storage.
*   **`autoscaler/` (TypeScript):**
    *   Implements the logic to query Prometheus metrics.
    *   Controls AWS EC2 to Launch (Scale Up) or Terminate (Scale Down) worker nodes.
    *   Uses AWS SDKs for EC2 and DynamoDB.

---

## 🛠️ Setup & Usage

### 1. Deploy Infrastructure
The `infra` directory contains the Pulumi program to build the AWS environment.

```bash
cd infra
npm install
pulumi up
```
*This will output critical connection details (Master IP, Subnets, etc.) needed for the autoscaler.*

### 2. Configure Autoscaler
The `autoscaler` directory contains the logic. It requires an environment file to connect to the infrastructure.

1.  Navigate to `autoscaler/`.
2.  Create a `.env` file with the values from the Pulumi output:
    ```env
    AWS_REGION=us-east-1
    MASTER_IP=<masterPublicIp>
    MASTER_PRIVATE_IP=<masterPrivateIp>
    AMI_ID=<ami-id>
    SUBNET_ID=<subnetId>
    SECURITY_GROUP_ID=<securityGroupId>
    CONFIG_BUCKET=<bucketName>
    ```

### 3. Run the Autoscaler
You can run the autoscaler logic directly (simulating a Lambda invocation).

```bash
cd autoscaler
npm install
npm run build
npx tsx index.ts
```

---

## 🧠 Current Implementation Details

*   **Bootstrapping:** The Master Node automatically installs K3s and uploads the Join Token to the S3 bucket.
*   **Node Provisioning:** New worker nodes are launched with a User Data script that fetches the token from S3 and joins the cluster automatically.
*   **Scaling Logic:**
    *   **Scale Up:** Triggered if CPU usage > 70% (Launches `t3.small`).
    *   **Scale Down:** Triggered if CPU usage < 30% (Terminates oldest worker).
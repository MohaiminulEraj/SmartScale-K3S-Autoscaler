import * as dotenv from 'dotenv';
dotenv.config();

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import * as tls from "@pulumi/tls";
import * as command from "@pulumi/command";

// --- 1. State Management (DynamoDB) ---
const stateTable = new aws.dynamodb.Table("SmartScale-State", {
    attributes: [
        { name: "pk", type: "S" },
    ],
    hashKey: "pk",
    billingMode: "PAY_PER_REQUEST",
    tags: {
        Project: "SmartScale-K3s",
    },
});

// --- 2. Configuration Storage (S3) ---

const configBucket = new aws.s3.Bucket("smartscale-configs", {

    forceDestroy: true,

    tags: {

        Project: "SmartScale-K3s",

    },

});



export const tableName = stateTable.name;

export const configBucketName = configBucket.bucket;



// --- Key Pair ---

const privateKey = new tls.PrivateKey("k3s-ssh-key", {

    algorithm: "RSA",

    rsaBits: 4096,

});



const keyPair = new aws.ec2.KeyPair("k3s-key", {

    publicKey: privateKey.publicKeyOpenssh,

});



export const privateKeyPem = privateKey.privateKeyPem;

// --- 3. Networking (VPC & Security) ---
const vpc = new aws.ec2.Vpc("k3s-vpc", {
    cidrBlock: "10.0.0.0/16",
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags: { Name: "k3s-vpc" },
});

const igw = new aws.ec2.InternetGateway("k3s-igw", {
    vpcId: vpc.id,
    tags: { Name: "k3s-igw" },
});

const publicRouteTable = new aws.ec2.RouteTable("k3s-public-rt-v2", {
    vpcId: vpc.id,
    tags: { Name: "k3s-public-rt-v2" },
});

const igwRoute = new aws.ec2.Route("igw-route", {
    routeTableId: publicRouteTable.id,
    destinationCidrBlock: "0.0.0.0/0",
    gatewayId: igw.id,
});

const subnet1 = new aws.ec2.Subnet("k3s-subnet-1", {
    vpcId: vpc.id,
    cidrBlock: "10.0.1.0/24",
    availabilityZone: "ap-southeast-1a",
    mapPublicIpOnLaunch: true,
    tags: { Name: "k3s-subnet-1" },
});

const subnet2 = new aws.ec2.Subnet("k3s-subnet-2", {
    vpcId: vpc.id,
    cidrBlock: "10.0.2.0/24",
    availabilityZone: "ap-southeast-1b",
    mapPublicIpOnLaunch: true,
    tags: { Name: "k3s-subnet-2" },
});

new aws.ec2.RouteTableAssociation("rta-subnet-1", {
    subnetId: subnet1.id,
    routeTableId: publicRouteTable.id,
});

new aws.ec2.RouteTableAssociation("rta-subnet-2", {
    subnetId: subnet2.id,
    routeTableId: publicRouteTable.id,
});

const k3sSg = new aws.ec2.SecurityGroup("k3s-sg", {
    vpcId: vpc.id,
    description: "Allow K3s traffic",
    ingress: [
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] }, 
        { protocol: "tcp", fromPort: 6443, toPort: 6443, cidrBlocks: ["0.0.0.0/0"] }, 
        { protocol: "udp", fromPort: 8472, toPort: 8472, self: true }, 
        { protocol: "tcp", fromPort: 10250, toPort: 10250, self: true }, 
        { protocol: "tcp", fromPort: 30000, toPort: 32767, cidrBlocks: ["0.0.0.0/0"] }, 
        { protocol: "tcp", fromPort: 443, toPort: 443, cidrBlocks: ["0.0.0.0/0"] }, // Allow HTTPS for VPC Endpoints
    ],
    egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
    tags: { Name: "k3s-sg" },
});

const ddbEndpoint = new aws.ec2.VpcEndpoint("ddb-endpoint", {
    vpcId: vpc.id,
    serviceName: pulumi.interpolate`com.amazonaws.ap-southeast-1.dynamodb`,
    vpcEndpointType: "Gateway",
    routeTableIds: [publicRouteTable.id],
});

const s3Endpoint = new aws.ec2.VpcEndpoint("s3-endpoint", {
    vpcId: vpc.id,
    serviceName: pulumi.interpolate`com.amazonaws.ap-southeast-1.s3`,
    vpcEndpointType: "Gateway",
    routeTableIds: [publicRouteTable.id],
});

const ec2Endpoint = new aws.ec2.VpcEndpoint("ec2-endpoint", {
    vpcId: vpc.id,
    serviceName: pulumi.interpolate`com.amazonaws.ap-southeast-1.ec2`,
    vpcEndpointType: "Interface",
    subnetIds: [subnet1.id, subnet2.id],
    securityGroupIds: [k3sSg.id],
    privateDnsEnabled: true,
});

export const vpcId = vpc.id;

// --- 4. IAM Roles ---

// Lambda Role
const lambdaRole = new aws.iam.Role("autoscaler-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
});

new aws.iam.RolePolicyAttachment("autoscaler-vpc-access", {
    role: lambdaRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
});

const lambdaPolicy = new aws.iam.RolePolicy("autoscaler-policy", {
    role: lambdaRole.id,
    policy: pulumi.all([stateTable.arn, configBucket.arn]).apply(([tableArn, bucketArn]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: "arn:aws:logs:*:*:*"
            },
            {
                Effect: "Allow",
                Action: ["ec2:RunInstances", "ec2:TerminateInstances", "ec2:DescribeInstances", "ec2:DescribeInstanceStatus", "ec2:CreateTags", "ec2:DescribeSubnets"],
                Resource: "*"
            },
            {
                Effect: "Allow",
                Action: "iam:PassRole",
                Resource: "*" 
            },
            {
                Effect: "Allow",
                Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan"],
                Resource: tableArn
            },
            {
                Effect: "Allow",
                Action: ["s3:GetObject"],
                Resource: `${bucketArn}/*`
            }
        ]
    })),
});

// Master Role
const ec2Role = new aws.iam.Role("ec2-master-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ec2.amazonaws.com" }),
});

const ec2Policy = new aws.iam.RolePolicy("ec2-master-policy", {
    role: ec2Role.id,
    policy: configBucket.arn.apply(arn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: ["s3:PutObject", "s3:GetObject"],
                Resource: `${arn}/*`
            }
        ]
    })),
});

const instanceProfile = new aws.iam.InstanceProfile("ec2-master-profile", {
    role: ec2Role.name,
});

// Worker Role (New)
const workerRole = new aws.iam.Role("ec2-worker-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "ec2.amazonaws.com" }),
});

const workerPolicy = new aws.iam.RolePolicy("ec2-worker-policy", {
    role: workerRole.id,
    policy: configBucket.arn.apply(arn => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: ["s3:GetObject"],
                Resource: `${arn}/*`
            },
            {
                Effect: "Allow",
                Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: "arn:aws:logs:*:*:*"
            }
        ]
    })),
});

const workerInstanceProfile = new aws.iam.InstanceProfile("ec2-worker-profile", {
    role: workerRole.name,
});


// --- 5. Master Node Setup ---
const ami = aws.ec2.getAmi({
    filters: [{ name: "name", values: ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"] }],
    owners: ["099720109477"], 
    mostRecent: true,
});

const masterUserData = configBucket.id.apply(bucketName => `#!/bin/bash
apt-get update && apt-get install -y unzip
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
./aws/install

# Install K3s (Master Mode)
curl -sfL https://get.k3s.io | sh -

# Wait for token and kubeconfig
while [ ! -f /var/lib/rancher/k3s/server/node-token ]; do sleep 2; done
while [ ! -f /etc/rancher/k3s/k3s.yaml ]; do sleep 2; done

# Upload token and kubeconfig to S3
aws s3 cp /var/lib/rancher/k3s/server/node-token s3://${bucketName}/node-token
aws s3 cp /etc/rancher/k3s/k3s.yaml s3://${bucketName}/k3s.yaml

# Create Service Account for Autoscaler (Draining)
# Wait for node ready
sleep 10
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
/usr/local/bin/k3s kubectl create serviceaccount autoscaler -n kube-system
/usr/local/bin/k3s kubectl create clusterrolebinding autoscaler-admin --clusterrole=cluster-admin --serviceaccount=kube-system:autoscaler

# Create Token
TOKEN=$(/usr/local/bin/k3s kubectl create token autoscaler -n kube-system --duration=8760h)
echo "$TOKEN" > /tmp/api-token
aws s3 cp /tmp/api-token s3://${bucketName}/api-token
`);

const masterNode = new aws.ec2.Instance("k3s-master", {
    instanceType: "t2.micro",
    vpcSecurityGroupIds: [k3sSg.id],
    ami: ami.then(a => a.id),
    subnetId: subnet1.id,
    keyName: keyPair.keyName,
    userData: masterUserData,
});

export const masterPublicIp = masterNode.publicIp;
export const masterPrivateIp = masterNode.privateIp;

// --- 6. Lambda Autoscaler ---

// We need the Autoscaler code to be available. 
// Assuming 'npm run build' was run in ../autoscaler
const autoscalerFn = new aws.lambda.Function("k3s-autoscaler", {
    code: new pulumi.asset.AssetArchive({
        ".": new pulumi.asset.FileArchive("../autoscaler"),
    }),
    runtime: "nodejs18.x",
    handler: "dist/index.handler", // Pointing to the compiled output
    role: lambdaRole.arn,
    timeout: 60,
    memorySize: 256,
    environment: {
        variables: {
            AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
            CONFIG_BUCKET: configBucket.id,
            DYNAMO_TABLE: stateTable.name,
            AMI_ID: ami.then(a => a.id),
            WORKER_SUBNET_IDS: pulumi.interpolate`${subnet1.id},${subnet2.id}`, // Comma separated
            SECURITY_GROUP_ID: k3sSg.id,
            EC2_ENDPOINT: ec2Endpoint.dnsEntries.apply(entries => `https://${entries[0].dnsName}`),
            // IAM_INSTANCE_PROFILE: workerInstanceProfile.name,
            MASTER_IP: masterNode.privateIp,
            CLUSTER_ID: "k3s-demo",
        },
    },
    vpcConfig: {
        subnetIds: [subnet1.id, subnet2.id],
        securityGroupIds: [k3sSg.id]
    }
});

export const autoscalerFunctionName = autoscalerFn.name;

// --- 7. Monitoring Stack (Helm) ---
const installMonitoring = new command.remote.Command("install-monitoring", {
    connection: {
        host: masterNode.publicIp,
        user: "ubuntu",
        privateKey: privateKey.privateKeyPem,
    },
    create: `
        set -e
        # Install Helm
        curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3
        chmod 700 get_helm.sh
        ./get_helm.sh
        
        # Configure Kubeconfig
        export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
        
        # Wait for K3s
        while ! /usr/local/bin/k3s kubectl get nodes; do sleep 5; done

        # Install Prometheus
        helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
        helm repo update
        helm install monitoring prometheus-community/kube-prometheus-stack \
          --namespace monitoring \
          --create-namespace \
          --set prometheus.service.type=NodePort \
          --set prometheus.service.nodePort=30090 \
          --set grafana.enabled=false \
          --set alertmanager.enabled=false \
          --wait
    `,
}, { dependsOn: [masterNode] });
import * as dotenv from 'dotenv';
dotenv.config();

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
// import * as k8s from "@pulumi/kubernetes";

// --- 1. State Management (DynamoDB) ---
// Stores the cluster state to prevent race conditions and track node counts.
const stateTable = new aws.dynamodb.Table("SmartScale-State", {
    attributes: [
        { name: "cluster_id", type: "S" },
    ],
    hashKey: "cluster_id",
    billingMode: "PAY_PER_REQUEST", // Cost optimization: Only pay for what we use
    tags: {
        Project: "SmartScale-K3s",
    },
});

// --- 2. Configuration Storage (S3) ---
// Stores the K3s join token and node installation scripts.
const configBucket = new aws.s3.Bucket("smartscale-configs", {
    forceDestroy: true, // Allows deleting bucket even if not empty (convenient for dev)
    tags: {
        Project: "SmartScale-K3s",
    },
});

export const tableName = stateTable.name;

// --- 3. Networking (VPC & Security) ---

// Create a new VPC
const vpc = new aws.ec2.Vpc("k3s-vpc", {
    cidrBlock: "10.0.0.0/16",
    enableDnsHostnames: true,
    enableDnsSupport: true,
    tags: { Name: "k3s-vpc" },
});

// Create an Internet Gateway so our nodes can reach the internet (to download K3s)
const igw = new aws.ec2.InternetGateway("k3s-igw", {
    vpcId: vpc.id,
    tags: { Name: "k3s-igw" },
});

// Create a Route Table for public internet access
const publicRouteTable = new aws.ec2.RouteTable("k3s-public-rt", {
    vpcId: vpc.id,
    routes: [
        { cidrBlock: "0.0.0.0/0", gatewayId: igw.id },
    ],
    tags: { Name: "k3s-public-rt" },
});

// Create Public Subnets in two Availability Zones
const subnet1 = new aws.ec2.Subnet("k3s-subnet-1", {
    vpcId: vpc.id,
    cidrBlock: "10.0.1.0/24",
    availabilityZone: "us-east-1a", // Adjust if your region is different
    mapPublicIpOnLaunch: true,
    tags: { Name: "k3s-subnet-1" },
});

const subnet2 = new aws.ec2.Subnet("k3s-subnet-2", {
    vpcId: vpc.id,
    cidrBlock: "10.0.2.0/24",
    availabilityZone: "us-east-1b",
    mapPublicIpOnLaunch: true,
    tags: { Name: "k3s-subnet-2" },
});

// Associate subnets with the Route Table
new aws.ec2.RouteTableAssociation("rta-subnet-1", {
    subnetId: subnet1.id,
    routeTableId: publicRouteTable.id,
});

new aws.ec2.RouteTableAssociation("rta-subnet-2", {
    subnetId: subnet2.id,
    routeTableId: publicRouteTable.id,
});

// Security Group for K3s Nodes
const k3sSg = new aws.ec2.SecurityGroup("k3s-sg", {
    vpcId: vpc.id,
    description: "Allow K3s traffic",
    ingress: [
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"] }, // SSH
        { protocol: "tcp", fromPort: 6443, toPort: 6443, cidrBlocks: ["0.0.0.0/0"] }, // K3s API
        { protocol: "udp", fromPort: 8472, toPort: 8472, self: true }, // Flannel VXLAN (Internal)
        { protocol: "tcp", fromPort: 10250, toPort: 10250, self: true }, // Kubelet Metrics
        { protocol: "tcp", fromPort: 30000, toPort: 32767, cidrBlocks: ["0.0.0.0/0"] }, // NodePorts (including Prometheus)
    ],
    egress: [
        { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] }, // Allow all outbound
    ],
    tags: { Name: "k3s-sg" },
});

export const vpcId = vpc.id;

// --- 4. IAM Role for Autoscaler Lambda ---

const lambdaRole = new aws.iam.Role("autoscaler-role", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
});

const lambdaPolicy = new aws.iam.RolePolicy("autoscaler-policy", {
    role: lambdaRole.id,
    policy: pulumi.all([stateTable.arn, configBucket.arn]).apply(([tableArn, bucketArn]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            // Logging
            {
                Effect: "Allow",
                Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: "arn:aws:logs:*:*:*"
            },
            // EC2 Management
            {
                Effect: "Allow",
                Action: ["ec2:RunInstances", "ec2:TerminateInstances", "ec2:DescribeInstances", "ec2:DescribeInstanceStatus", "ec2:CreateTags"],
                Resource: "*"
            },
            {
                Effect: "Allow",
                Action: "iam:PassRole",
                Resource: "*" // Ideally restricted to the EC2 instance profile role
            },
            // DynamoDB Access
            {
                Effect: "Allow",
                Action: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan"],
                Resource: tableArn
            },
            // S3 Access (Read Only for Configs)
            {
                Effect: "Allow",
                Action: ["s3:GetObject"],
                Resource: `${bucketArn}/*`
            }
        ]
    })),
});


// --- 5. Master Node Setup ---

// IAM Role for the EC2 Master Node (needs to write token to S3)
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

// Get the latest Ubuntu 22.04 AMI
const ami = aws.ec2.getAmi({
    filters: [{ name: "name", values: ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"] }],
    owners: ["099720109477"], // Canonical
    mostRecent: true,
});

// User Data Script: Install K3s and upload token to S3
const masterUserData = configBucket.id.apply(bucketName => `#!/bin/bash
apt-get update && apt-get install -y unzip
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
./aws/install

# Install K3s (Master Mode)
curl -sfL https://get.k3s.io | sh -

# Wait for token to be generated
while [ ! -f /var/lib/rancher/k3s/server/node-token ]; do sleep 2; done

# Upload token to S3 so workers can find it
aws s3 cp /var/lib/rancher/k3s/server/node-token s3://${bucketName}/node-token
`);

// Create the Master Node
const masterNode = new aws.ec2.Instance("k3s-master", {
    instanceType: "t3.medium", // As per requirements
    vpcSecurityGroupIds: [k3sSg.id],
    ami: ami.then(a => a.id),
    subnetId: subnet1.id,
    iamInstanceProfile: instanceProfile.name,
    userData: masterUserData,
    tags: {
        Name: "k3s-master",
        Role: "Master"
    },
});

export const masterPublicIp = masterNode.publicIp;
export const masterPrivateIp = masterNode.privateIp;


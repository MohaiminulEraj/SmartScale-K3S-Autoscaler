import * as dotenv from 'dotenv';
dotenv.config();

import { EC2Client, RunInstancesCommand, TerminateInstancesCommand, DescribeInstancesCommand } from "@aws-sdk/client-ec2";
import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import axios from 'axios';

// --- Configuration ---
const REGION = process.env.AWS_REGION || "us-east-1";
const MASTER_IP = process.env.MASTER_IP; // Public IP of K3s Master
const PROMETHEUS_PORT = 30090; // NodePort for Prometheus
const AMI_ID = process.env.AMI_ID; // Ubuntu AMI
const SUBNET_ID = process.env.SUBNET_ID;
const SECURITY_GROUP_ID = process.env.SECURITY_GROUP_ID;
const MIN_NODES = 2;
const MAX_NODES = 10;
const DYNAMO_TABLE = "SmartScale-State";
const CLUSTER_ID = "k3s-demo";

// --- Clients ---
const ec2 = new EC2Client({ region: REGION });
const ddb = DynamoDBClient.from({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddb);

// --- Prometheus Queries ---
// Average CPU usage across all worker nodes (excluding master if possible, or total cluster avg)
const CPU_QUERY = `100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[2m])) * 100)`;

async function getCpuUsage(): Promise<number> {
    try {
        const url = `http://${MASTER_IP}:${PROMETHEUS_PORT}/api/v1/query`;
        console.log(`🔍 Querying Prometheus at ${url}...`);
        
        const response = await axios.get(url, {
            params: { query: CPU_QUERY },
            timeout: 5000 
        });

        if (response.data.status === 'success' && response.data.data.result.length > 0) {
            const value = parseFloat(response.data.data.result[0].value[1]);
            console.log(`📊 Current Cluster Average CPU: ${value.toFixed(2)}%`);
            return value;
        }
        console.warn("⚠️ No metric data returned from Prometheus.");
        return 0;
    } catch (error) {
        console.error("❌ Failed to fetch metrics from Prometheus:", (error as any).message);
        return 0; // Fail safe: Assume 0 load to avoid scaling up on error
    }
}

async function getWorkerNodes() {
    // Find all running instances tagged as 'Worker'
    const command = new DescribeInstancesCommand({
        Filters: [
            { Name: "tag:Role", Values: ["Worker"] },
            { Name: "instance-state-name", Values: ["running", "pending"] }
        ]
    });
    const data = await ec2.send(command);
    const instances = data.Reservations?.flatMap(r => r.Instances || []) || [];
    return instances;
}

async function scaleUp(currentCount: number) {
    if (currentCount >= MAX_NODES) {
        console.log("🛑 Max node count reached. Skipping scale up.");
        return;
    }

    console.log("🚀 Scaling UP! Launching a new worker node...");

    // User Data to join the cluster
    // Requires the Master IP and Token (fetched from S3 in a real scenario, or passed here)
    // For MVP: We assume the worker script in S3 handles the join logic
    const userData = `#!/bin/bash
aws s3 cp s3://${process.env.CONFIG_BUCKET}/node-token /tmp/token
TOKEN=$(cat /tmp/token)
curl -sfL https://get.k3s.io | K3S_URL=https://${process.env.MASTER_PRIVATE_IP}:6443 K3S_TOKEN=$TOKEN sh -
`;
    const userDataEncoded = Buffer.from(userData).toString('base64');

    const command = new RunInstancesCommand({
        ImageId: AMI_ID,
        InstanceType: "t3.small",
        MinCount: 1,
        MaxCount: 1,
        SubnetId: SUBNET_ID,
        SecurityGroupIds: [SECURITY_GROUP_ID!],
        UserData: userDataEncoded,
        IamInstanceProfile: { Name: "ec2-master-profile" }, // Reusing profile for S3 access
        TagSpecifications: [{
            ResourceType: "instance",
            Tags: [{ Key: "Role", Value: "Worker" }, { Key: "Name", Value: `k3s-worker-${Date.now()}` }]
        }]
    });

    await ec2.send(command);
    console.log("✅ Scale Up triggered successfully.");
}

async function scaleDown(workers: any[]) {
    if (workers.length <= MIN_NODES) {
        console.log("🛡️ Min node count reached. Skipping scale down.");
        return;
    }

    // Find the oldest worker to terminate
    // Sort by LaunchTime (oldest first)
    workers.sort((a, b) => (a.LaunchTime?.getTime() || 0) - (b.LaunchTime?.getTime() || 0));
    const nodeToKill = workers[0];

    console.log(`📉 Scaling DOWN. Terminating node: ${nodeToKill.InstanceId}`);

    // In a real system: kubectl drain <node> first!
    
    const command = new TerminateInstancesCommand({
        InstanceIds: [nodeToKill.InstanceId!]
    });

    await ec2.send(command);
    console.log("✅ Node terminated.");
}

export const handler = async (event: any) => {
    console.log("⏰ Autoscaler triggered.");
    
    // 1. Get Metrics
    const cpuUsage = await getCpuUsage();
    
    // 2. Get Current State
    const workers = await getWorkerNodes();
    const workerCount = workers.length;
    console.log(`ℹ️ Active Workers: ${workerCount}`);

    // 3. Make Decision
    if (cpuUsage > 70) {
        await scaleUp(workerCount);
    } else if (cpuUsage < 30) {
        await scaleDown(workers);
    } else {
        console.log("⚖️ Load is balanced. No action needed.");
    }
    
    return { statusCode: 200, body: "Scaling check complete" };
};

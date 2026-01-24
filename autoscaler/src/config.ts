import * as KP from 'dotenv';
KP.config();

export const CONFIG = {
    REGION: process.env.AWS_REGION || "ap-southeast-1",
    MASTER_IP: process.env.MASTER_IP || "",
    PROMETHEUS_PORT: 30090, // Hardcoded nodeport
    AMI_ID: process.env.AMI_ID || "",
    WORKER_SUBNET_IDS: (process.env.WORKER_SUBNET_IDS || "").split(","),
    SECURITY_GROUP_ID: process.env.SECURITY_GROUP_ID || "",
    IAM_INSTANCE_PROFILE: process.env.IAM_INSTANCE_PROFILE || "",
    EC2_ENDPOINT: process.env.EC2_ENDPOINT || "",
    CONFIG_BUCKET: process.env.CONFIG_BUCKET || "",
    DYNAMO_TABLE: process.env.DYNAMO_TABLE || "SmartScale-State",
    CLUSTER_ID: process.env.CLUSTER_ID || "k3s-demo",

    // Autoscaling Logic
    MIN_NODES: Number(process.env.MIN_NODES || 2),
    MAX_NODES: Number(process.env.MAX_NODES || 10),
    SCALE_UP_CPU_THRESHOLD: Number(process.env.SCALE_UP_CPU_THRESHOLD || 70),
    SCALE_DOWN_CPU_THRESHOLD: Number(process.env.SCALE_DOWN_CPU_THRESHOLD || 30),
    PENDING_POD_TIMEOUT: Number(process.env.PENDING_POD_TIMEOUT || 180),
    SCALE_UP_COOLDOWN: Number(process.env.SCALE_UP_COOLDOWN || 300),
    SCALE_DOWN_COOLDOWN: Number(process.env.SCALE_DOWN_COOLDOWN || 600),
};

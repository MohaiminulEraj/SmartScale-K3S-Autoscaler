import { EC2Client, RunInstancesCommand, TerminateInstancesCommand, DescribeInstancesCommand, DescribeSubnetsCommand } from "@aws-sdk/client-ec2";
import { CONFIG } from '../config';

const ec2 = new EC2Client({ 
    region: CONFIG.REGION,
    endpoint: CONFIG.EC2_ENDPOINT || undefined 
});

export interface WorkerNode {
    instanceId: string;
    privateIp: string;
    launchTime: Date;
    azbP: string;
    subnetId: string;
}

export class Ec2Adapter {
    async listWorkers(): Promise<WorkerNode[]> {
        const res = await ec2.send(new DescribeInstancesCommand({
            Filters: [
                { Name: "tag:Role", Values: ["Worker", "k3s-worker"] }, // Support both tags just in case
                { Name: "instance-state-name", Values: ["running", "pending"] },
                { Name: "tag:Cluster", Values: [CONFIG.CLUSTER_ID, "k3s-autoscaler"] }
            ]
        }));

        const nodes: WorkerNode[] = [];
        for (const r of res.Reservations || []) {
            for (const i of r.Instances || []) {
                if (i.InstanceId && i.PrivateIpAddress) {
                    nodes.push({
                        instanceId: i.InstanceId,
                        privateIp: i.PrivateIpAddress,
                        launchTime: i.LaunchTime || new Date(),
                        azbP: i.Placement?.AvailabilityZone || "",
                        subnetId: i.SubnetId || ""
                    });
                }
            }
        }
        return nodes;
    }

    async getSubnetAzs(subnetIds: string[]) {
        if (subnetIds.length === 0) return new Map<string, string[]>();
        const res = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: subnetIds }));
        const map = new Map<string, string[]>();
        for (const s of res.Subnets || []) {
            if (s.AvailabilityZone && s.SubnetId) {
                const list = map.get(s.AvailabilityZone) || [];
                list.push(s.SubnetId);
                map.set(s.AvailabilityZone, list);
            }
        }
        return map;
    }

    async launchInstance(count: number, token: string): Promise<string[]> {
        // 1. Balance AZs
        const workers = await this.listWorkers();
        const subnetIds = CONFIG.WORKER_SUBNET_IDS;
        const subnetsByAz = await this.getSubnetAzs(subnetIds);
        
        const azCounts = new Map<string, number>();
        // Init AZ counts
        for (const az of subnetsByAz.keys()) azCounts.set(az, 0);
        // Count existing
        for (const w of workers) {
            if (w.azbP) azCounts.set(w.azbP, (azCounts.get(w.azbP) || 0) + 1);
        }

        // Sort AZs by count
        const azs = Array.from(subnetsByAz.keys()).sort((a, b) => (azCounts.get(a) || 0) - (azCounts.get(b) || 0));
        
        if (azs.length === 0) throw new Error("No AZs/Subnets found");
        const targetAz = azs[0];
        const targetSubnet = subnetsByAz.get(targetAz)?.[0]; // Just pick first subnet in that AZ

        if (!targetSubnet) throw new Error("No subnet in target AZ");

        const userData = `#!/bin/bash
# Install K3s Agent
curl -sfL https://get.k3s.io | K3S_URL=https://${CONFIG.MASTER_IP}:6443 K3S_TOKEN=${token} sh -
`;
        const userDataEncoded = Buffer.from(userData).toString('base64');

        // Try Spot
        try {
            return await this.runInstances(targetSubnet, userDataEncoded, true);
        } catch (e) {
            console.log("Spot launch failed, trying On-Demand", e);
            return await this.runInstances(targetSubnet, userDataEncoded, false);
        }
    }

    private async runInstances(subnetId: string, userData: string, spot: boolean): Promise<string[]> {
        const res = await ec2.send(new RunInstancesCommand({
            ImageId: CONFIG.AMI_ID,
            InstanceType: "t2.micro",
            MinCount: 1,
            MaxCount: 1,
            SubnetId: subnetId,
            SecurityGroupIds: [CONFIG.SECURITY_GROUP_ID],
            UserData: userData,
            IamInstanceProfile: CONFIG.IAM_INSTANCE_PROFILE ? { Name: CONFIG.IAM_INSTANCE_PROFILE } : undefined,
            InstanceMarketOptions: spot ? { MarketType: "spot" } : undefined,
            TagSpecifications: [{
                ResourceType: "instance",
                Tags: [
                    { Key: "Role", Value: "Worker" },
                    { Key: "Name", Value: `k3s-worker-${Date.now()}` },
                    { Key: "Cluster", Value: CONFIG.CLUSTER_ID }
                ]
            }]
        }));
        return res.Instances?.map(i => i.InstanceId!).filter(Boolean) || [];
    }

    async terminateInstance(instanceId: string) {
        await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    }

    async describeInstances(ids: string[]) {
        if (ids.length === 0) return [];
        const res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: ids }));
        return res.Reservations?.flatMap(r => r.Instances || []) || [];
    }
}

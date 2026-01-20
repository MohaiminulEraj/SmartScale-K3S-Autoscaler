import * as k8s from "@pulumi/kubernetes";

// Create the namespace first
const ns = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" }
});

// Install the Prometheus Stack into that specific namespace
const prometheusStack = new k8s.helm.v3.Chart("prometheus-stack", {
    repo: "prometheus-community",
    chart: "kube-prometheus-stack",
    namespace: ns.metadata.name, // Tell Helm to use the namespace we just built
    values: {
        grafana: { enabled: false },
        alertmanager: { enabled: false },
        prometheus: {
            service: {
                type: "LoadBalancer",
                nodePort: 30090
            }
        }
    },
    fetchOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
}, { dependsOn: ns }); // CRITICAL: This tells Pulumi "Don't start this until the Namespace is ready!"

export const namespaceName = ns.metadata.name;
export const prometheusUrl = "http://localhost:9090";

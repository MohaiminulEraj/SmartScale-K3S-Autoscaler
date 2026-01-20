import * as k8s from "@pulumi/kubernetes";

// Install the Prometheus-Community Helm Chart
const prometheusStack = new k8s.helm.v3.Chart("prometheus-stack", {
    repo: "prometheus-community",
    chart: "kube-prometheus-stack",
    namespace: "monitoring",
    values: {
        grafana: { enabled: false },
        alertmanager: { enabled: false },
        prometheus: {
            service: {
                type: "LoadBalancer",
                // This 'nodePort' combined with the k3d port mapping ensures
                // we can reach it at localhost:9090
                nodePort: 30090
            }
        }
    },
    fetchOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
});

export const namespaceName = "monitoring";

export const prometheusUrl = "http://localhost:9090";

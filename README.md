# 🚀 SmartScale K3s Autoscaler

This project implements a custom autoscaler for K3s using TypeScript and Pulumi.

## 📂 Project Structure
* **infra/**: Infrastructure as Code (Pulumi) for the K3s cluster & Prometheus.
* **autoscaler/**: TypeScript logic that reads metrics and triggers scaling.
---

### 1. Start the Infrastructure (K3d)
The cluster pauses when you shut down. Wake it up:
```bash
k3d cluster start smartscale

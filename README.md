# SmartScale K3s Autoscaler

## Local Setup
Create the cluster:
`k3d cluster create smartscale --agents 2 --port "9090:9090@loadbalancer" --image rancher/k3s:v1.34.3-k3s1`

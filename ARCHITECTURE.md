# High-Level Architecture (SmartScale K3s Autoscaler)

This ASCII design visualizes the end-to-End flow of the system, designed to resemble a whiteboard architecture sketch.

```text
+--------------------------------------------------------------------------------------------------+
|  AWS CLOUD (ap-southeast-1)                                                                      |
|                                                                                                  |
|  +-------------------------------------------------------------+                                 |
|  |  K3s CLUSTER (VPC / Private Network)                        |                                 |
|  |                                                             |                                 |
|  |   +-------------------+           +-------------------+     |                                 |
|  |   |                   |           |                   |     |                                 |
|  |   |    MASTER NODE    |---------->|   WORKER NODE 1   |     |                                 |
|  |   |    (t2.micro)     |           |   (Spot Instance) |     |                                 |
|  |   |                   |           |                   |     |                                 |
|  |   +---------+---------+           +---------+---------+     |                                 |
|  |             |                             |                 |                                 |
|  |             |                             |                 |                                 |
|  |             v                             v                 |                                 |
|  |   +---------------------------------------------------+     |                                 |
|  |   |                 PROMETHEUS SERVER                 |     |                                 |
|  |   |          (Aggregates CPU & Pod Metrics)           |     |                                 |
|  |   |               Exposed on Port 30090               |     |                                 |
|  |   +-------------------------+-------------------------+     |                                 |
|  |                             |                               |                                 |
|  +-----------------------------|-------------------------------+                                 |
|                                |                                                                 |
|                                | 1. Query Metrics (HTTP)                                         |
|                                v                                                                 |
|                      +-------------------+                                                       |
|                      |                   |                                                       |
|    (Manual Trigger)  |    AWS LAMBDA     |                                                       |
|    ----------------->|   (Autoscaler)    |                                                       |
|                      |                   |                                                       |
|                      +----+------+---+-+-+                                                       |
|                           |      |   | |                                                         |
|          2. Acquire Lock  |      |   | |  3. Fetch Tokens                                        |
|          & Check State    |      |   | |                                                         |
|                           |      |   | |                                                         |
|      +--------------------+      |   | +----------------------+                                  |
|      |                           |   |                        |                                  |
|      v                           |   v                        v                                  |
| +----------+              +------+-------+             +------------+                            |
| |          |              |              |             |            |                            |
| | DYNAMODB |              |   EC2 API    |             |  S3 BUCKET |                            |
| | (State)  |              | (Launch/Term)|             |  (Config)  |                            |
| |          |              |              |             |            |                            |
| +----------+              +------+-------+             +------------+                            |
|                                  |                                                               |
|                                  | 4. Launch New Instance                                        |
|                                  |    (PrivateLink Endpoint)                                     |
|                                  |                                                               |
|                                  v                                                               |
|                       +--------------------+                                                     |
|                       |  NEW WORKER NODE   |                                                     |
|                       |    (t2.micro)      |                                                     |
|                       +--------------------+                                                     |
|                                                                                                  |
+--------------------------------------------------------------------------------------------------+
```

## 📐 Design Flow

1.  **Observability Layer**:
    *   **Prometheus** sits inside the cluster, scraping metrics from all nodes.
    *   It acts as the "Sensors" of the system.

2.  **Control Plane (Lambda)**:
    *   The **Lambda** is the "Brain". It sits outside the cluster (but inside the VPC).
    *   It wakes up, checks **Prometheus** to see if the cluster is stressed (High CPU) or empty (Idle).

3.  **Consistency Layer**:
    *   **DynamoDB** acts as the "Traffic Cop". It ensures only one scaling action happens at a time (Locking).
    *   **S3** acts as the "Key Vault". It securely passes the Join Token to new nodes.

4.  **Action Layer**:
    *   **Scale Up**: Lambda calls **EC2 API** to spawn a new worker. The worker downloads the token from S3 and auto-joins the master.
    *   **Scale Down**: Lambda talks to **K3s Master** to drain a node, then tells **EC2** to kill it.

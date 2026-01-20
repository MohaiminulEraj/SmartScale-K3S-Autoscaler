import axios from 'axios';

const PROMETHEUS_URL = 'http://localhost:9090';

async function checkClusterHealth() {
    try {
        console.log("🔍 Checking Prometheus connectivity...");

        // Query 1: Simple 'up' check to see if Prometheus is alive
        const response = await axios.get(`${PROMETHEUS_URL}/api/v1/query`, {
            params: { query: 'up' }
        });

        if (response.data.status === 'success') {
            console.log("✅ Prometheus is Online!");
            const nodeCount = response.data.data.result.length;
            console.log(`📊 Found ${nodeCount} monitoring targets (nodes/pods).`);
        } else {
            console.error("⚠️ Prometheus returned an error:", response.data);
        }

    } catch (error) {
        console.error("❌ Failed to connect to Prometheus:", (error as any).message);
    }
}

checkClusterHealth();

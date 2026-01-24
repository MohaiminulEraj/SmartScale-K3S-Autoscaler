import { DynamoAdapter } from './adapters/dynamodb';
import { Ec2Adapter } from './adapters/ec2';
import { K8sAdapter } from './adapters/k8s';
import { decide } from './core/decision';
import { getS3Content } from './adapters/s3';

const db = new DynamoAdapter();
const ec2 = new Ec2Adapter();
const k8s = new K8sAdapter();

export const handler = async (event: any, context: any) => {
    console.log("Event:", JSON.stringify(event));
    const now = Math.floor(Date.now() / 1000);
    const requestId = context.awsRequestId;

    // 1. Handle Spot Interruptions
    if (event["detail-type"] === "EC2 Spot Instance Interruption Warning") {
        const instanceId = event.detail["instance-id"];
        console.log(`Spot Interruption for ${instanceId}`);
        // Lock? simplified: just act.
        // Drain & Terminate? AWS terminates for us in 2 mins.
        // We should launch replacement.
        // Drain first
        const workers = await ec2.listWorkers();
        const target = workers.find(w => w.instanceId === instanceId);
        if (target) {
            try {
                await k8s.drainNode(target.privateIp);
            } catch (e) { console.error("Drain failed", e); }
        }
        
        // Launch Replacement
        try {
            const token = await getS3Content("node-token");
            await ec2.launchInstance(1, token);
        } catch (e) { console.error("Replacement launch failed", e); }
        
        return;
    }

    // 2. Normal Scaling
    // Lock
    const locked = await db.acquireLock(requestId, 300); // 5 min lock
    if (!locked) {
        console.log("Could not acquire lock, skipping.");
        return;
    }

    try {
        const state = await db.getState();
        
        // Check "Verify Phase" for Scale Up
        if (state.scalingInProgress && state.scaleUpActionId) {
             // Logic to verify nodes joined...
             // For simplification, let's assume if enough time passed, we complete it.
             // Or check Prom.
             const readyNodes = await k8s.getReadyNodes();
             // If all launched IDs are in readyNodes...
             // Simplified: just complete it after a delay
             if (now - (state.scaleUpStartedEpoch || 0) > 120) {
                 await db.completeScaleUp(state.scaleUpActionId, now);
             }
             return;
        }

        const metrics = await k8s.getMetrics();
        const workers = await ec2.listWorkers();
        
        const decision = decide(metrics.avgCpu, metrics.pendingPods, workers.length, state.lastScaleEpoch, state.scalingInProgress, now);
        
        console.log("Decision:", JSON.stringify(decision));

        if (decision.type === "SCALE_UP") {
            const actionId = `up-${now}`;
            await db.beginScaleUp(actionId, now);
            const token = await getS3Content("node-token");
            const ids = await ec2.launchInstance(decision.delta, token);
            await db.recordScaleUpInstances(actionId, ids);
            console.log("Launched:", ids);
        } else if (decision.type === "SCALE_DOWN") {
            const actionId = `down-${now}`;
            // Pick Victim: Oldest
            const victim = workers.sort((a,b) => a.launchTime.getTime() - b.launchTime.getTime())[0];
            if (victim) {
                await db.beginScaleDown(actionId, now, [victim.instanceId]);
                await k8s.drainNode(victim.privateIp);
                await ec2.terminateInstance(victim.instanceId);
                await db.markScaleDownCompleted(actionId, victim.instanceId);
                await db.completeScaleDown(actionId, now);
                console.log("Terminated:", victim.instanceId);
            }
        }

    } catch (e) {
        console.error("Error in handler", e);
    } finally {
        await db.releaseLock(requestId);
    }
};

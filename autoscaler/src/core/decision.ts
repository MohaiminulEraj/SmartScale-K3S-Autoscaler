import { CONFIG } from '../config';

export type Decision = 
    | { type: "NOOP", reason: string }
    | { type: "SCALE_UP", delta: number, reason: string }
    | { type: "SCALE_DOWN", delta: number, reason: string };

export function decide(
    cpu: number, 
    pending: number, 
    workerCount: number, 
    lastScaleEpoch: number,
    scalingInProgress: boolean,
    now: number
): Decision {
    
    if (scalingInProgress) return { type: "NOOP", reason: "Scaling in progress" };

    const timeSinceLast =now - lastScaleEpoch;

    // Scale Up
    if (workerCount < CONFIG.MAX_NODES) {
        if (timeSinceLast < CONFIG.SCALE_UP_COOLDOWN) {
            // Check if strict cooldown needed? Usually yes.
        } else {
             if (cpu > CONFIG.SCALE_UP_CPU_THRESHOLD || pending > 0) {
                 return { type: "SCALE_UP", delta: 1, reason: pending > 0 ? "Pending Pods" : "High CPU" };
             }
        }
    }

    // Scale Down
    if (workerCount > CONFIG.MIN_NODES) {
        if (timeSinceLast < CONFIG.SCALE_DOWN_COOLDOWN) {
            // wait
        } else {
            if (cpu < CONFIG.SCALE_DOWN_CPU_THRESHOLD && pending === 0) {
                return { type: "SCALE_DOWN", delta: 1, reason: "Low CPU & Idle" };
            }
        }
    }

    return { type: "NOOP", reason: "Stable" };
}

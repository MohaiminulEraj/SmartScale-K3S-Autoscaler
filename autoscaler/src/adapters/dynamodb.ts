import { DynamoDBClient, UpdateItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { CONFIG } from '../config';

const ddb = new DynamoDBClient({ region: CONFIG.REGION });

export interface State {
    scalingInProgress: boolean;
    lastScaleEpoch: number;
    workerCount: number;
    scaleUpActionId?: string;
    scaleUpStartedEpoch?: number;
    scaleUpInstanceIds?: string[];
    scaleDownActionId?: string;
    scaleDownStartedEpoch?: number;
    scaleDownTargetInstanceIds?: string[];
    scaleDownCompletedInstanceIds?: string[];
}

export class DynamoAdapter {
    private tableName = CONFIG.DYNAMO_TABLE;
    private pk = "cluster"; // Single item for cluster state

    async ensureState() {
        // Basic check/init handled by Pulumi or first run logic
    }

    async getState(): Promise<State> {
        const res = await ddb.send(new GetItemCommand({
            TableName: this.tableName,
            Key: marshall({ pk: this.pk }),
            ConsistentRead: true
        }));
        
        if (!res.Item) {
            return {
                scalingInProgress: false,
                lastScaleEpoch: 0,
                workerCount: 0
            };
        }
        return unmarshall(res.Item) as State;
    }

    async acquireLock(owner: string, ttl: number): Promise<boolean> {
        const now = Math.floor(Date.now() / 1000);
        const lockKey = `lock#${this.pk}`;
        try {
            await ddb.send(new UpdateItemCommand({
                TableName: this.tableName,
                Key: marshall({ pk: lockKey }),
                UpdateExpression: "SET lockHeld=:t, lockOwner=:o, lockUntil=:u",
                ConditionExpression: "attribute_not_exists(lockHeld) OR lockHeld=:f OR lockUntil < :now",
                ExpressionAttributeValues: marshall({
                    ":t": true,
                    ":f": false,
                    ":o": owner,
                    ":u": now + ttl,
                    ":now": now
                })
            }));
            return true;
        } catch (e: any) {
            if (e.name === "ConditionalCheckFailedException") return false;
            throw e;
        }
    }

    async releaseLock(owner: string): Promise<void> {
        const lockKey = `lock#${this.pk}`;
        try {
            await ddb.send(new UpdateItemCommand({
                TableName: this.tableName,
                Key: marshall({ pk: lockKey }),
                UpdateExpression: "SET lockHeld=:f",
                ConditionExpression: "lockOwner = :o",
                ExpressionAttributeValues: marshall({
                    ":f": false,
                    ":o": owner
                })
            }));
        } catch (e) {
            // Ignore if we lost the lock
        }
    }

    // --- State Transitions ---

    async beginScaleUp(actionId: string, now: number) {
        await ddb.send(new UpdateItemCommand({
            TableName: this.tableName,
            Key: marshall({ pk: this.pk }),
            UpdateExpression: "SET scalingInProgress=:t, scaleUpActionId=:aid, scaleUpStartedEpoch=:now, scaleUpInstanceIds=:empty",
            ConditionExpression: "attribute_not_exists(scalingInProgress) OR scalingInProgress=:f",
            ExpressionAttributeValues: marshall({
                ":t": true,
                ":f": false,
                ":aid": actionId,
                ":now": now,
                ":empty": []
            })
        }));
    }

    async recordScaleUpInstances(actionId: string, instanceIds: string[]) {
        await ddb.send(new UpdateItemCommand({
            TableName: this.tableName,
            Key: marshall({ pk: this.pk }),
            UpdateExpression: "SET scaleUpInstanceIds=:ids",
            ConditionExpression: "scaleUpActionId=:aid",
            ExpressionAttributeValues: marshall({
                ":aid": actionId,
                ":ids": instanceIds
            })
        }));
    }

    async completeScaleUp(actionId: string, now: number) {
        await ddb.send(new UpdateItemCommand({
            TableName: this.tableName,
            Key: marshall({ pk: this.pk }),
            UpdateExpression: "SET scalingInProgress=:f, lastScaleEpoch=:now REMOVE scaleUpActionId, scaleUpStartedEpoch, scaleUpInstanceIds",
            ConditionExpression: "scaleUpActionId=:aid",
            ExpressionAttributeValues: marshall({
                ":f": false,
                ":now": now,
                ":aid": actionId
            })
        }));
    }

    async beginScaleDown(actionId: string, now: number, targets: string[]) {
        await ddb.send(new UpdateItemCommand({
            TableName: this.tableName,
            Key: marshall({ pk: this.pk }),
            UpdateExpression: "SET scalingInProgress=:t, scaleDownActionId=:aid, scaleDownStartedEpoch=:now, scaleDownTargetInstanceIds=:tgt, scaleDownCompletedInstanceIds=:empty",
            ConditionExpression: "attribute_not_exists(scalingInProgress) OR scalingInProgress=:f",
            ExpressionAttributeValues: marshall({
                ":t": true,
                ":f": false,
                ":aid": actionId,
                ":now": now,
                ":tgt": targets,
                ":empty": []
            })
        }));
    }

    async markScaleDownCompleted(actionId: string, instanceId: string) {
        // Add to list
         await ddb.send(new UpdateItemCommand({
            TableName: this.tableName,
            Key: marshall({ pk: this.pk }),
            UpdateExpression: "SET scaleDownCompletedInstanceIds = list_append(if_not_exists(scaleDownCompletedInstanceIds, :empty), :one)",
            ConditionExpression: "scaleDownActionId=:aid",
            ExpressionAttributeValues: marshall({
                ":aid": actionId,
                ":empty": [],
                ":one": [instanceId]
            })
        }));
    }

    async completeScaleDown(actionId: string, now: number) {
        await ddb.send(new UpdateItemCommand({
            TableName: this.tableName,
            Key: marshall({ pk: this.pk }),
            UpdateExpression: "SET scalingInProgress=:f, lastScaleEpoch=:now REMOVE scaleDownActionId, scaleDownStartedEpoch, scaleDownTargetInstanceIds, scaleDownCompletedInstanceIds",
            ConditionExpression: "scaleDownActionId=:aid",
            ExpressionAttributeValues: marshall({
                ":f": false,
                ":now": now,
                ":aid": actionId
            })
        }));
    }

    async failScaling(now: number) {
         await ddb.send(new UpdateItemCommand({
            TableName: this.tableName,
            Key: marshall({ pk: this.pk }),
            UpdateExpression: "SET scalingInProgress=:f REMOVE scaleUpActionId, scaleDownActionId",
            ExpressionAttributeValues: marshall({
                ":f": false
            })
        }));
    }
}

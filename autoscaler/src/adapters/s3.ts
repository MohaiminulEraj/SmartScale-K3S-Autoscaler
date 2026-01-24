import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { CONFIG } from '../config';
import { Readable } from 'stream';

const s3 = new S3Client({ region: CONFIG.REGION });

export async function getS3Content(key: string): Promise<string> {
    const res = await s3.send(new GetObjectCommand({
        Bucket: CONFIG.CONFIG_BUCKET,
        Key: key
    }));
    const stream = res.Body as Readable;
    return new Promise((resolve, reject) => {
        const chunks: any[] = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()));
    });
}

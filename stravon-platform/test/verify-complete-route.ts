/**
 * Focused test for POST /v1/storage/files/complete
 * Verifies:
 * 1. The route returns { verified: boolean, bytes: number }
 * 2. The original call_logs row from POST /v1/storage/files is updated with real bytes
 * 3. No duplicate call_logs row is created for the /complete request
 */

import { createHash, randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const API_BASE = 'http://localhost:3000';
const TEST_FILE_CONTENT = 'Complete route verification test content.';
const TEST_FILE_NAME = 'complete-verify.txt';

async function apiFetch(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {},
) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: { ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, ok: res.ok, data };
}

async function main() {
  console.log('=== POST /v1/storage/files/complete Verification ===\n');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('FAIL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Create a test project with storage permissions
  const projectId = randomUUID();
  const apiKey = `test-complete-key-${randomUUID().slice(0, 8)}`;
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

  const { error: insertError } = await supabase.from('projects').insert({
    project_id: projectId,
    name: 'Complete Route Test Project',
    owner: 'verification',
    category: 'single_client',
    tier: 'entry',
    permissions: {
      storage: ['read', 'create', 'modify', 'delete'],
      auth: [],
      db: [],
    },
    api_key_hash: apiKeyHash,
  });

  if (insertError) {
    console.error('FAIL: Could not create project:', insertError.message);
    process.exit(1);
  }
  console.log(`1. Project created: ${projectId}`);

  // Count call_logs before
  const { count: beforeCount } = await supabase
    .from('call_logs')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId);
  console.log(`   call_logs before any request: ${beforeCount}`);

  // Step 1: POST /v1/storage/files
  console.log('\n2. POST /v1/storage/files...');
  const createRes = await apiFetch('/v1/storage/files', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: {
      filename: TEST_FILE_NAME,
      contentType: 'text/plain',
      fileSize: Buffer.byteLength(TEST_FILE_CONTENT),
    },
  });

  if (!createRes.ok) {
    console.error(`   FAIL: POST returned ${createRes.status}:`, createRes.data);
    await supabase.from('projects').delete().eq('project_id', projectId);
    process.exit(1);
  }

  const key = createRes.data.key;
  console.log(`   OK: Key = ${key}`);

  // Count call_logs after POST
  const { count: afterPostCount } = await supabase
    .from('call_logs')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId);
  console.log(`   call_logs after POST: ${afterPostCount}`);

  // Check the call_logs row from POST
  const { data: postLogs, error: postLogsError } = await supabase
    .from('call_logs')
    .select('*')
    .eq('project_id', projectId)
    .eq('service', 'storage')
    .eq('action', 'create')
    .order('created_at', { ascending: false });

  if (postLogsError) {
    console.error('   FAIL: Could not query call_logs:', postLogsError.message);
    await supabase.from('projects').delete().eq('project_id', projectId);
    process.exit(1);
  }

  const postLog = postLogs?.[0];
  console.log(`   POST call_logs row: bytes=${postLog?.bytes}, storage_key=${postLog?.storage_key}, log_id=${postLog?.log_id}`);

  // Upload the file to R2
  console.log('\n3. Uploading file to R2 via presigned URL...');
  const putRes = await fetch(createRes.data.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: TEST_FILE_CONTENT,
  });

  if (!putRes.ok) {
    const putText = await putRes.text();
    console.error(`   FAIL: PUT returned ${putRes.status}: ${putText}`);
    await supabase.from('projects').delete().eq('project_id', projectId);
    process.exit(1);
  }
  console.log('   OK: File uploaded to R2');

  // Step 2: POST /v1/storage/files/complete
  console.log('\n4. POST /v1/storage/files/complete...');
  const completeRes = await apiFetch('/v1/storage/files/complete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: { key },
  });

  if (!completeRes.ok) {
    console.error(`   FAIL: /complete returned ${completeRes.status}:`, completeRes.data);
    await supabase.from('projects').delete().eq('project_id', projectId);
    process.exit(1);
  }

  console.log(`   Response: ${JSON.stringify(completeRes.data)}`);
  const expectedBytes = Buffer.byteLength(TEST_FILE_CONTENT);
  const verified = completeRes.data.verified === true;
  const bytesMatch = completeRes.data.bytes === expectedBytes;

  console.log(`   verified === true: ${verified}`);
  console.log(`   bytes === ${expectedBytes}: ${bytesMatch}`);

  // Count call_logs after /complete
  const { count: afterCompleteCount } = await supabase
    .from('call_logs')
    .select('*', { count: 'exact', head: true })
    .eq('project_id', projectId);
  console.log(`\n5. call_logs after /complete: ${afterCompleteCount}`);

  // Check if the original row was updated
  const { data: finalLogs, error: finalLogsError } = await supabase
    .from('call_logs')
    .select('*')
    .eq('project_id', projectId)
    .eq('service', 'storage')
    .eq('action', 'create')
    .order('created_at', { ascending: false });

  if (finalLogsError) {
    console.error('   FAIL: Could not query final call_logs:', finalLogsError.message);
    await supabase.from('projects').delete().eq('project_id', projectId);
    process.exit(1);
  }

  const finalLog = finalLogs?.[0];
  console.log(`   Final call_logs row: bytes=${finalLog?.bytes}, storage_key=${finalLog?.storage_key}, log_id=${finalLog?.log_id}`);

  // Verify no duplicate row
  const noDuplicate = afterCompleteCount === afterPostCount;
  console.log(`\n6. No duplicate call_logs row created: ${noDuplicate}`);
  console.log(`   (before POST: ${beforeCount}, after POST: ${afterPostCount}, after /complete: ${afterCompleteCount})`);

  // Verify bytes were updated to the real R2 value
  const bytesUpdated = finalLog?.bytes === expectedBytes;
  console.log(`   Original bytes updated to real R2 value (${expectedBytes}): ${bytesUpdated}`);

  // Cleanup
  await supabase.from('projects').delete().eq('project_id', projectId);
  console.log('\n   Test project cleaned up');

  // Summary
  console.log('\n=== Summary ===');
  const allPassed = verified && bytesMatch && noDuplicate && bytesUpdated;
  console.log(`  verified === true: ${verified ? 'PASS' : 'FAIL'}`);
  console.log(`  bytes === ${expectedBytes}: ${bytesMatch ? 'PASS' : 'FAIL'}`);
  console.log(`  no duplicate call_logs row: ${noDuplicate ? 'PASS' : 'FAIL'}`);
  console.log(`  bytes updated to real R2 value: ${bytesUpdated ? 'PASS' : 'FAIL'}`);
  console.log(`\nOverall: ${allPassed ? 'ALL PASSED' : 'FAILED'}`);

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error('Verification failed with unexpected error:', err);
  process.exit(1);
});

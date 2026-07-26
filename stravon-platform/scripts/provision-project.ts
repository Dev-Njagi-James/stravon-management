/**
 * Stage A — Provision a new project.
 *
 * Interactive CLI that:
 *   1. Prompts for project details (name, owner, category, tier, permissions)
 *   2. Generates a cryptographically random API key
 *   3. Hashes it using the EXACT same method as ApiKeyGuard
 *   4. Inserts a row into the projects table
 *   5. Prints the raw API key once (never stored in plaintext)
 *
 * Usage: npx ts-node scripts/provision-project.ts
 */

import { createHash, randomBytes, randomUUID } from 'crypto';
import * as readline from 'readline';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ── Supabase client ──────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    'ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env',
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ── Readline helper ──────────────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function select<T extends string>(
  label: string,
  options: readonly T[],
): Promise<T> {
  const formatted = options.map((o, i) => `  ${i + 1}) ${o}`).join('\n');
  const answer = await question(
    `${label}\n${formatted}\nEnter number (1-${options.length}): `,
  );
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < options.length) {
    return options[idx];
  }
  console.log(`  Invalid choice, defaulting to "${options[0]}".`);
  return options[0];
}

async function multiSelect(
  label: string,
  options: string[],
): Promise<string[]> {
  console.log(`\n${label}`);
  console.log(
    '  Enter comma-separated numbers (e.g. "1,2,3") or "all" or "none".',
  );
  const formatted = options.map((o, i) => `  ${i + 1}) ${o}`).join('\n');
  console.log(formatted);

  const answer = await question('  Choices: ');
  const trimmed = answer.trim().toLowerCase();

  if (trimmed === 'all') return [...options];
  if (trimmed === '' || trimmed === 'none') return [];

  const parsed = trimmed.split(',').map((s) => parseInt(s.trim(), 10));
  const valid = parsed.filter(
    (n) => !isNaN(n) && n >= 1 && n <= options.length,
  );
  const invalid = parsed.filter((n) => isNaN(n) || n < 1 || n > options.length);

  if (invalid.length > 0) {
    console.log(
      `  Warning: ignoring invalid choices: ${invalid.join(', ')} ` +
        `(valid range is 1-${options.length})`,
    );
  }

  return valid.map((i) => options[i - 1]);
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║       Stravon Platform — Project Provisioning       ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  // 1. Collect project details ────────────────────────────────────────
  const name = await question('Project name: ');
  if (!name.trim()) {
    console.error('ERROR: Project name is required.');
    process.exit(1);
  }

  const owner = await question('Owner: ');
  if (!owner.trim()) {
    console.error('ERROR: Owner is required.');
    process.exit(1);
  }

  const category = await select('Category:', [
    'single_client',
    'saas_tenant',
  ] as const);
  const tier = await select('Tier:', [
    'entry',
    'starter',
    'growth',
    'scale',
  ] as const);

  const allActions = ['read', 'create', 'modify', 'delete'];
  const services = ['storage', 'auth', 'db'] as const;

  const permissions: Record<string, string[]> = {};
  for (const service of services) {
    const actions = await multiSelect(
      `Permissions for "${service}" service:`,
      allActions,
    );
    permissions[service] = actions;
  }

  // 2. Generate API key and hash ──────────────────────────────────────
  const rawApiKey = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(rawApiKey).digest('hex');

  // 3. Insert into projects table ─────────────────────────────────────
  const projectId = randomUUID();

  console.log('\n  Inserting project into database...');

  const { error: insertError } = await supabase.from('projects').insert({
    project_id: projectId,
    name: name.trim(),
    owner: owner.trim(),
    category,
    tier,
    permissions,
    api_key_hash: hash,
  });

  if (insertError) {
    console.error('\n  ERROR: Failed to insert project:', insertError.message);
    process.exit(1);
  }

  // 4. Verify the row was written ─────────────────────────────────────
  const { data: verify, error: verifyError } = await supabase
    .from('projects')
    .select('project_id, name, owner, category, tier, permissions')
    .eq('project_id', projectId)
    .single();

  if (verifyError || !verify) {
    console.error(
      '\n  ERROR: Could not verify project was created:',
      verifyError?.message,
    );
    process.exit(1);
  }

  // 5. Print result ───────────────────────────────────────────────────
  console.log('\n  ✅ Project created successfully!');
  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────┐');
  console.log('  │  ⚠  SAVE THIS KEY NOW — IT WILL NEVER BE SHOWN    │');
  console.log('  │           AGAIN AND IS NOT STORED ANYWHERE         │');
  console.log('  └─────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`  API Key:  ${rawApiKey}`);
  console.log('');
  console.log('  Project details:');
  console.log(`    project_id: ${verify.project_id}`);
  console.log(`    name:       ${verify.name}`);
  console.log(`    owner:      ${verify.owner}`);
  console.log(`    category:   ${verify.category}`);
  console.log(`    tier:       ${verify.tier}`);
  console.log(`    permissions: ${JSON.stringify(verify.permissions)}`);
  console.log('');

  rl.close();
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

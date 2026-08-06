import { Injectable, OnModuleInit } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface CallLogEntry {
  project_id: string;
  service: string;
  action: string;
  status: string;
  latency_ms: number;
  bytes?: number | null;
  bytes_direction?: string | null;
  storage_key?: string | null;
}

@Injectable()
export class SupabaseService implements OnModuleInit {
  private supabaseClient: any;

  onModuleInit() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error(
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be defined in the environment variables.',
      );
    }

    this.supabaseClient = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  get client(): SupabaseClient<any, 'public', any> {
    return this.supabaseClient as SupabaseClient<any, 'public', any>;
  }

  async insertCallLog(entry: CallLogEntry): Promise<void> {
    const { error } = await this.client.from('call_logs').insert(entry);
    if (error) {
      console.error('insertCallLog: insert failed', error);
    }
  }
}

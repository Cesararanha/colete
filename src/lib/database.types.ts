export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      data_exports: {
        Row: {
          content_digest: string | null;
          created_at: string;
          downloaded_at: string | null;
          expires_at: string | null;
          id: string;
          privacy_request_id: string;
          profile_id: string;
          purged_at: string | null;
          ready_at: string | null;
          status: string;
          storage_path: string | null;
        };
        Insert: {
          content_digest?: string | null;
          created_at?: string;
          downloaded_at?: string | null;
          expires_at?: string | null;
          id?: string;
          privacy_request_id: string;
          profile_id: string;
          purged_at?: string | null;
          ready_at?: string | null;
          status?: string;
          storage_path?: string | null;
        };
        Update: {
          content_digest?: string | null;
          created_at?: string;
          downloaded_at?: string | null;
          expires_at?: string | null;
          id?: string;
          privacy_request_id?: string;
          profile_id?: string;
          purged_at?: string | null;
          ready_at?: string | null;
          status?: string;
          storage_path?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'data_exports_privacy_request_id_fkey';
            columns: ['privacy_request_id'];
            isOneToOne: true;
            referencedRelation: 'privacy_requests';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'data_exports_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      policy_acceptances: {
        Row: {
          accepted_at: string;
          document_type: string;
          id: number;
          profile_id: string;
          source: string;
          version: string;
        };
        Insert: {
          accepted_at?: string;
          document_type: string;
          id?: never;
          profile_id: string;
          source: string;
          version: string;
        };
        Update: {
          accepted_at?: string;
          document_type?: string;
          id?: never;
          profile_id?: string;
          source?: string;
          version?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'policy_acceptances_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      privacy_requests: {
        Row: {
          id: string;
          kind: string;
          opened_at: string;
          profile_id: string | null;
          resolved_at: string | null;
          response: string | null;
          status: string;
        };
        Insert: {
          id?: string;
          kind: string;
          opened_at?: string;
          profile_id?: string | null;
          resolved_at?: string | null;
          response?: string | null;
          status?: string;
        };
        Update: {
          id?: string;
          kind?: string;
          opened_at?: string;
          profile_id?: string | null;
          resolved_at?: string | null;
          response?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'privacy_requests_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      profiles: {
        Row: {
          account_status: string;
          auth_user_id: string | null;
          created_at: string;
          deidentified_at: string | null;
          dominant_foot: string | null;
          id: string;
          name: string;
          nickname: string | null;
          photo_url: string | null;
          position: string | null;
          shirt_number: number | null;
          status_changed_at: string | null;
        };
        Insert: {
          account_status?: string;
          auth_user_id?: string | null;
          created_at?: string;
          deidentified_at?: string | null;
          dominant_foot?: string | null;
          id?: string;
          name: string;
          nickname?: string | null;
          photo_url?: string | null;
          position?: string | null;
          shirt_number?: number | null;
          status_changed_at?: string | null;
        };
        Update: {
          account_status?: string;
          auth_user_id?: string | null;
          created_at?: string;
          deidentified_at?: string | null;
          dominant_foot?: string | null;
          id?: string;
          name?: string;
          nickname?: string | null;
          photo_url?: string | null;
          position?: string | null;
          shirt_number?: number | null;
          status_changed_at?: string | null;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      accept_policies: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_request_id: string;
          p_versions: Json;
        };
        Returns: Json;
      };
      complete_profile: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_profile: Json;
          p_request_id: string;
        };
        Returns: Json;
      };
      delete_account: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      finalize_deletion: { Args: { p_request_id: string }; Returns: Json };
      get_own_deletion_request: {
        Args: never;
        Returns: Database['public']['CompositeTypes']['deletion_request_projection'][];
        SetofOptions: {
          from: '*';
          to: 'deletion_request_projection';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      revoke_current_session: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      update_profile: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_patch: Json;
          p_request_id: string;
        };
        Returns: Json;
      };
      worker_acquire_external_effect: {
        Args: { p_supported_kinds: string[] };
        Returns: Json;
      };
      worker_begin_job: { Args: { p_job_name: string }; Returns: Json };
      worker_complete_external_effect: {
        Args: {
          p_effect_id: string;
          p_error_code: string;
          p_lease_token: string;
          p_result: string;
        };
        Returns: Json;
      };
      worker_confirm_deletion_effect: {
        Args: { p_effect_id: string; p_lease_token: string };
        Returns: Json;
      };
      worker_execute_database_job: { Args: { p_run_id: number }; Returns: Json };
      worker_finish_job: {
        Args: {
          p_error_code: string;
          p_run_id: number;
          p_status: string;
          p_summary: Json;
        };
        Returns: Json;
      };
      worker_get_deletion_effect_target: {
        Args: { p_effect_id: string; p_lease_token: string };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      deletion_request_projection: {
        id: string | null;
        status: string | null;
        requested_at: string | null;
        completed_at: string | null;
        has_operational_failure: boolean | null;
      };
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;

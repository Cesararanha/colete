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
        Args: { extensions?: Json; operationName?: string; query?: string; variables?: Json };
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
      group_invites: {
        Row: {
          code_digest: string | null;
          created_at: string;
          created_by: string;
          expires_at: string;
          group_id: string;
          id: string;
          max_uses: number;
          public_nonce: string;
          revoked_at: string | null;
          token_digest: string;
          token_version: number;
          used_count: number;
        };
        Insert: {
          code_digest?: string | null;
          created_at?: string;
          created_by: string;
          expires_at: string;
          group_id: string;
          id?: string;
          max_uses?: number;
          public_nonce: string;
          revoked_at?: string | null;
          token_digest: string;
          token_version?: number;
          used_count?: number;
        };
        Update: {
          code_digest?: string | null;
          created_at?: string;
          created_by?: string;
          expires_at?: string;
          group_id?: string;
          id?: string;
          max_uses?: number;
          public_nonce?: string;
          revoked_at?: string | null;
          token_digest?: string;
          token_version?: number;
          used_count?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'group_invites_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'group_invites_group_id_fkey';
            columns: ['group_id'];
            isOneToOne: false;
            referencedRelation: 'groups';
            referencedColumns: ['id'];
          },
        ];
      };
      group_members: {
        Row: {
          group_id: string;
          is_monthly: boolean;
          joined_at: string;
          last_requested_at: string;
          profile_id: string;
          removal_count: number;
          removed_at: string | null;
          role: string;
          status: string;
        };
        Insert: {
          group_id: string;
          is_monthly?: boolean;
          joined_at?: string;
          last_requested_at?: string;
          profile_id: string;
          removal_count?: number;
          removed_at?: string | null;
          role?: string;
          status?: string;
        };
        Update: {
          group_id?: string;
          is_monthly?: boolean;
          joined_at?: string;
          last_requested_at?: string;
          profile_id?: string;
          removal_count?: number;
          removed_at?: string | null;
          role?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'group_members_group_id_fkey';
            columns: ['group_id'];
            isOneToOne: false;
            referencedRelation: 'groups';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'group_members_profile_id_fkey';
            columns: ['profile_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      groups: {
        Row: {
          archived_at: string | null;
          color: string;
          created_at: string;
          icon: string;
          id: string;
          monthly_enabled: boolean;
          name: string;
          owner_id: string;
          photo_url: string | null;
          ratings_visibility: string;
          suspended_at: string | null;
        };
        Insert: {
          archived_at?: string | null;
          color?: string;
          created_at?: string;
          icon?: string;
          id?: string;
          monthly_enabled?: boolean;
          name: string;
          owner_id: string;
          photo_url?: string | null;
          ratings_visibility?: string;
          suspended_at?: string | null;
        };
        Update: {
          archived_at?: string | null;
          color?: string;
          created_at?: string;
          icon?: string;
          id?: string;
          monthly_enabled?: boolean;
          name?: string;
          owner_id?: string;
          photo_url?: string | null;
          ratings_visibility?: string;
          suspended_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'groups_owner_id_fkey';
            columns: ['owner_id'];
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
      approve_member: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_approve: boolean;
          p_canonical_version: number;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_profile_id: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      begin_photo_upload: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_request_id: string;
          p_target: string;
        };
        Returns: Json;
      };
      cancel_match: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_match_id: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      check_and_debit_invite_attempt: {
        Args: { p_actor_auth_user_id: string; p_actor_session_id: string; profile_id: string };
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
      consume_data_export: {
        Args: { p_actor_auth_user_id: string; p_actor_session_id: string; p_export_id: string };
        Returns: Json;
      };
      create_group: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_code_digest: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_invite_id: string;
          p_name: string;
          p_nonce_hex: string;
          p_request_id: string;
          p_token_digest: string;
          p_token_version: number;
        };
        Returns: Json;
      };
      create_match: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_config: Json;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
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
      delete_group: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      enqueue_data_export_purge: { Args: { p_export_id: string }; Returns: Json };
      finalize_deletion: { Args: { p_request_id: string }; Returns: Json };
      geocode_reserve: {
        Args: { p_actor_auth_user_id: string; p_actor_session_id: string; p_spend: boolean };
        Returns: Json;
      };
      get_group_members: {
        Args: { p_actor_auth_user_id: string; p_actor_session_id: string; p_group_id: string };
        Returns: {
          display_name: string;
          profile_id: string;
          role: string;
          status: string;
        }[];
      };
      get_invite_share_link: {
        Args: { p_actor_auth_user_id: string; p_actor_session_id: string; p_invite_id: string };
        Returns: Json;
      };
      get_match: {
        Args: { p_actor_auth_user_id: string; p_actor_session_id: string; p_match_id: string };
        Returns: {
          canceled: boolean;
          description: string;
          ends_at: string;
          field_price: number;
          field_slots: number;
          group_color: string;
          group_icon: string;
          group_id: string;
          group_name: string;
          id: string;
          latitude: number;
          location_address: string;
          location_name: string;
          longitude: number;
          starts_at: string;
          timezone: string;
        }[];
      };
      get_match_roster: {
        Args: { p_actor_auth_user_id: string; p_actor_session_id: string; p_match_id: string };
        Returns: Json;
      };
      get_matches_occupancy: {
        Args: { p_actor_auth_user_id: string; p_actor_session_id: string };
        Returns: {
          canceled: boolean;
          confirmed_count: number;
          match_id: string;
          viewer_status: string;
          waitlist_count: number;
        }[];
      };
      get_my_pending_group_requests: {
        Args: { p_actor_auth_user_id: string; p_actor_session_id: string };
        Returns: Json;
      };
      get_own_data_exports: {
        Args: Record<PropertyKey, never>;
        Returns: Database['public']['CompositeTypes']['data_export_projection'][];
        SetofOptions: {
          from: '*';
          to: 'data_export_projection';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      get_own_deletion_request: {
        Args: Record<PropertyKey, never>;
        Returns: Database['public']['CompositeTypes']['deletion_request_projection'][];
        SetofOptions: {
          from: '*';
          to: 'deletion_request_projection';
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      get_photo_upload_target: {
        Args: { p_actor_auth_user_id: string; p_actor_session_id: string; p_upload_id: string };
        Returns: Json;
      };
      get_visible_photos: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_group_ids: string[];
          p_profile_ids: string[];
        };
        Returns: {
          bucket: string;
          kind: string;
          object_path: string;
          subject_id: string;
        }[];
      };
      issue_group_invite: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_code_digest: string;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_new_invite_id: string;
          p_nonce_hex: string;
          p_request_id: string;
          p_token_digest: string;
          p_token_version: number;
        };
        Returns: Json;
      };
      join_by_code: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_code_digest: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      join_by_invite: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_invite_id: string;
          p_request_id: string;
          p_token_digest: string;
          p_token_version: number;
        };
        Returns: Json;
      };
      join_match: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_match_id: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      leave_group: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      leave_match: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_match_id: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      list_my_matches: {
        Args: { p_actor_auth_user_id: string; p_actor_session_id: string };
        Returns: {
          canceled: boolean;
          ends_at: string;
          field_price: number;
          field_slots: number;
          group_color: string;
          group_icon: string;
          group_id: string;
          group_name: string;
          id: string;
          latitude: number;
          location_address: string;
          location_name: string;
          longitude: number;
          starts_at: string;
          timezone: string;
        }[];
      };
      mark_invite_attempt_success: {
        Args: { attempt_id: string; p_actor_auth_user_id: string; p_actor_session_id: string };
        Returns: undefined;
      };
      preview_group_by_code: {
        Args: { p_actor_auth_user_id: string; p_actor_session_id: string; p_code_digest: string };
        Returns: Json;
      };
      preview_group_by_invite: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_invite_id: string;
          p_token_digest: string;
          p_token_version: number;
        };
        Returns: Json;
      };
      regenerate_group_invite: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_code_digest: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_invite_id: string;
          p_nonce_hex: string;
          p_request_id: string;
          p_token_digest: string;
          p_token_version: number;
        };
        Returns: Json;
      };
      remove_group_photo: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      remove_member: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_profile_id: string;
          p_reason: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      remove_profile_photo: {
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
      rename_group: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_name: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      request_data_export: {
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
      revoke_group_invite: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_invite_id: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      set_group_appearance: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_color: string;
          p_group_id: string;
          p_hash_key_version: number;
          p_icon: string;
          p_input_hmac: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      set_group_photo: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_request_id: string;
          p_upload_id: string;
        };
        Returns: Json;
      };
      set_match_payment: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_match_id: string;
          p_paid: boolean;
          p_profile_id: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      set_monthly: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_enabled: boolean;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_profile_id: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      set_profile_photo: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_request_id: string;
          p_upload_id: string;
        };
        Returns: Json;
      };
      set_ratings_visibility: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_confirm_members_visibility: boolean;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_request_id: string;
          p_visibility: string;
        };
        Returns: Json;
      };
      set_role: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_profile_id: string;
          p_request_id: string;
          p_role: string;
        };
        Returns: Json;
      };
      transfer_ownership: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_group_id: string;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_new_owner_id: string;
          p_request_id: string;
        };
        Returns: Json;
      };
      update_match: {
        Args: {
          p_actor_auth_user_id: string;
          p_actor_session_id: string;
          p_canonical_version: number;
          p_config: Json;
          p_hash_key_version: number;
          p_input_hmac: string;
          p_match_id: string;
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
      worker_acquire_external_effect: { Args: { p_supported_kinds: string[] }; Returns: Json };
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
        Args: { p_error_code: string; p_run_id: number; p_status: string; p_summary: Json };
        Returns: Json;
      };
      worker_get_data_export_build_target: {
        Args: { p_effect_id: string; p_lease_token: string };
        Returns: Json;
      };
      worker_get_deletion_effect_target: {
        Args: { p_effect_id: string; p_lease_token: string };
        Returns: Json;
      };
      worker_publish_data_export: {
        Args: {
          p_content_digest: string;
          p_effect_id: string;
          p_lease_token: string;
          p_storage_path: string;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      data_export_projection: {
        id: string | null;
        status: string | null;
        created_at: string | null;
        ready_at: string | null;
        expires_at: string | null;
        downloaded_at: string | null;
        purged_at: string | null;
      };
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
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
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

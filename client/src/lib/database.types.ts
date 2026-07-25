export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      chat_messages: {
        Row: {
          chat_id: number
          content: string
          created_at: string
          error_message: string | null
          first_read_at: string | null
          id: number
          last_read_at: string | null
          read_count: number
          role: string
          status: string
          translations: Json
          user_id: string
          word_index_at: string | null
          word_index_version: number | null
        }
        Insert: {
          chat_id: number
          content?: string
          created_at?: string
          error_message?: string | null
          first_read_at?: string | null
          id?: never
          last_read_at?: string | null
          read_count?: number
          role: string
          status?: string
          translations?: Json
          user_id: string
          word_index_at?: string | null
          word_index_version?: number | null
        }
        Update: {
          chat_id?: number
          content?: string
          created_at?: string
          error_message?: string | null
          first_read_at?: string | null
          id?: never
          last_read_at?: string | null
          read_count?: number
          role?: string
          status?: string
          translations?: Json
          user_id?: string
          word_index_at?: string | null
          word_index_version?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "chat_messages_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "chats"
            referencedColumns: ["id"]
          },
        ]
      }
      chats: {
        Row: {
          created_at: string
          id: number
          last_activity_at: string
          title: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: never
          last_activity_at?: string
          title: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: never
          last_activity_at?: string
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      kanji: {
        Row: {
          character: string
          grade: number
          jlpt: number | null
          meanings: string
          readings_kun: string
          readings_on: string
        }
        Insert: {
          character: string
          grade: number
          jlpt?: number | null
          meanings: string
          readings_kun: string
          readings_on: string
        }
        Update: {
          character?: string
          grade?: number
          jlpt?: number | null
          meanings?: string
          readings_kun?: string
          readings_on?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          openrouter_api_key_secret_id: string | null
          preferences: Json
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          openrouter_api_key_secret_id?: string | null
          preferences?: Json
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          openrouter_api_key_secret_id?: string | null
          preferences?: Json
          user_id?: string
        }
        Relationships: []
      }
      stories: {
        Row: {
          allowed_kanji: string
          comprehensibility: Json | null
          content: string
          content_type: string
          created_at: string
          difficulty: Json
          error_message: string | null
          filters: Json
          first_read_at: string | null
          formality: string
          id: number
          last_read_at: string | null
          paragraphs: number
          read_count: number
          refine_pass: number
          refine_state: string | null
          status: string
          title: string
          topic: string | null
          translations: Json | null
          user_id: string
          word_index_at: string | null
          word_index_version: number | null
        }
        Insert: {
          allowed_kanji: string
          comprehensibility?: Json | null
          content: string
          content_type?: string
          created_at?: string
          difficulty: Json
          error_message?: string | null
          filters: Json
          first_read_at?: string | null
          formality: string
          id?: never
          last_read_at?: string | null
          paragraphs: number
          read_count?: number
          refine_pass?: number
          refine_state?: string | null
          status?: string
          title: string
          topic?: string | null
          translations?: Json | null
          user_id: string
          word_index_at?: string | null
          word_index_version?: number | null
        }
        Update: {
          allowed_kanji?: string
          comprehensibility?: Json | null
          content?: string
          content_type?: string
          created_at?: string
          difficulty?: Json
          error_message?: string | null
          filters?: Json
          first_read_at?: string | null
          formality?: string
          id?: never
          last_read_at?: string | null
          paragraphs?: number
          read_count?: number
          refine_pass?: number
          refine_state?: string | null
          status?: string
          title?: string
          topic?: string | null
          translations?: Json | null
          user_id?: string
          word_index_at?: string | null
          word_index_version?: number | null
        }
        Relationships: []
      }
      story_word_occurrences: {
        Row: {
          chat_message_id: number | null
          end_offset: number
          entry_id: number | null
          headword: string
          id: number
          is_name: boolean
          manual: boolean
          reading: string | null
          start_offset: number
          story_id: number | null
          surface: string
          user_id: string
        }
        Insert: {
          chat_message_id?: number | null
          end_offset: number
          entry_id?: number | null
          headword: string
          id?: never
          is_name?: boolean
          manual?: boolean
          reading?: string | null
          start_offset: number
          story_id?: number | null
          surface: string
          user_id: string
        }
        Update: {
          chat_message_id?: number | null
          end_offset?: number
          entry_id?: number | null
          headword?: string
          id?: never
          is_name?: boolean
          manual?: boolean
          reading?: string | null
          start_offset?: number
          story_id?: number | null
          surface?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "story_word_occurrences_chat_message_id_fkey"
            columns: ["chat_message_id"]
            isOneToOne: false
            referencedRelation: "chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "story_word_occurrences_story_id_fkey"
            columns: ["story_id"]
            isOneToOne: false
            referencedRelation: "stories"
            referencedColumns: ["id"]
          },
        ]
      }
      user_kanji: {
        Row: {
          character: string
          known: boolean
          user_id: string
        }
        Insert: {
          character: string
          known?: boolean
          user_id: string
        }
        Update: {
          character?: string
          known?: boolean
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_kanji_character_fkey"
            columns: ["character"]
            isOneToOne: false
            referencedRelation: "kanji"
            referencedColumns: ["character"]
          },
        ]
      }
      word_lookups: {
        Row: {
          chat_message_id: number | null
          end_offset: number
          headword: string
          id: number
          looked_up_at: string
          lookup_count: number
          reading: string | null
          start_offset: number
          story_id: number | null
          surface: string
          user_id: string
        }
        Insert: {
          chat_message_id?: number | null
          end_offset: number
          headword: string
          id?: never
          looked_up_at?: string
          lookup_count?: number
          reading?: string | null
          start_offset: number
          story_id?: number | null
          surface: string
          user_id: string
        }
        Update: {
          chat_message_id?: number | null
          end_offset?: number
          headword?: string
          id?: never
          looked_up_at?: string
          lookup_count?: number
          reading?: string | null
          start_offset?: number
          story_id?: number | null
          surface?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "word_lookups_chat_message_id_fkey"
            columns: ["chat_message_id"]
            isOneToOne: false
            referencedRelation: "chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "word_lookups_story_id_fkey"
            columns: ["story_id"]
            isOneToOne: false
            referencedRelation: "stories"
            referencedColumns: ["id"]
          },
        ]
      }
      word_reviews: {
        Row: {
          box: number
          eligible_at: string
          headword: string
          last_reviewed_at: string
          user_id: string
        }
        Insert: {
          box?: number
          eligible_at?: string
          headword: string
          last_reviewed_at?: string
          user_id: string
        }
        Update: {
          box?: number
          eligible_at?: string
          headword?: string
          last_reviewed_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      clear_all_story_word_overrides: {
        Args: { p_story_id: number }
        Returns: undefined
      }
      clear_openrouter_api_key: { Args: never; Returns: undefined }
      clear_story_word_overrides: {
        Args: {
          p_region_end: number
          p_region_start: number
          p_story_id: number
        }
        Returns: undefined
      }
      delete_chat: { Args: { p_chat_id: number }; Returns: undefined }
      get_chat_message_word_encounters: {
        Args: { p_message_id: number }
        Returns: {
          encounters: number
          end_offset: number
          start_offset: number
        }[]
      }
      get_chats_with_read_stats: {
        Args: never
        Returns: {
          created_at: string
          id: number
          last_activity_at: string
          last_read_at: string
          min_assistant_read_count: number
          title: string
        }[]
      }
      get_openrouter_api_key_for_user: {
        Args: { p_user_id: string }
        Returns: string
      }
      get_per_chat_payout: {
        Args: never
        Returns: {
          chat_id: number
          count: number
          key: string
          kind: string
        }[]
      }
      get_per_story_word_occurrences: {
        Args: never
        Returns: {
          headword: string
          occurrences: number
          story_id: number
        }[]
      }
      get_review_queue: {
        Args: never
        Returns: {
          headword: string
          last_read_at: string
        }[]
      }
      get_stories_needing_refinement: {
        Args: never
        Returns: {
          content: string
          id: number
          refine_pass: number
        }[]
      }
      get_story_word_encounters: {
        Args: { p_story_id: number }
        Returns: {
          encounters: number
          end_offset: number
          start_offset: number
        }[]
      }
      get_user_word_encounters: {
        Args: never
        Returns: {
          encounters: number
          headword: string
          last_read_at: string
        }[]
      }
      get_word_encounters: { Args: { p_headword: string }; Returns: number }
      get_word_usages: {
        Args: { p_headword: string }
        Returns: {
          chat_id: number
          chat_message_id: number
          end_offset: number
          looked_up_at: string
          lookup_count: number
          occurrence_id: number
          reading: string
          source_content: string
          source_created_at: string
          source_title: string
          source_type: string
          start_offset: number
          story_id: number
          surface: string
        }[]
      }
      index_chat_message_words: {
        Args: { p_message_id: number; p_occurrences: Json; p_version: number }
        Returns: string
      }
      index_story_words: {
        Args: { p_occurrences: Json; p_story_id: number; p_version: number }
        Returns: string
      }
      mark_chat_message_read: {
        Args: { p_message_id: number }
        Returns: {
          first_read_at: string
          last_read_at: string
          read_count: number
        }[]
      }
      mark_chat_read: {
        Args: { p_chat_id: number }
        Returns: {
          first_read_at: string
          last_read_at: string
          message_id: number
          read_count: number
        }[]
      }
      mark_story_read: {
        Args: { p_story_id: number }
        Returns: {
          first_read_at: string
          last_read_at: string
          read_count: number
        }[]
      }
      record_word_lookup: {
        Args: {
          p_chat_message_id?: number
          p_end: number
          p_headword: string
          p_reading: string
          p_start: number
          p_story_id: number
          p_surface: string
        }
        Returns: undefined
      }
      record_word_review: {
        Args: { p_headword: string; p_passed: boolean }
        Returns: undefined
      }
      reset_chat_word_index: { Args: { p_chat_id: number }; Returns: undefined }
      set_openrouter_api_key: { Args: { p_key: string }; Returns: undefined }
      set_story_word_overrides: {
        Args: {
          p_overrides: Json
          p_region_end: number
          p_region_start: number
          p_story_id: number
        }
        Returns: undefined
      }
      settle_story_refinement: {
        Args: { p_metrics: Json; p_story_id: number }
        Returns: undefined
      }
      strip_ruby: { Args: { t: string }; Returns: string }
      undo_chat_message_read: {
        Args: { p_message_id: number }
        Returns: {
          first_read_at: string
          last_read_at: string
          read_count: number
        }[]
      }
      undo_chat_read: {
        Args: { p_chat_id: number; p_message_ids: number[] }
        Returns: {
          first_read_at: string
          last_read_at: string
          message_id: number
          read_count: number
        }[]
      }
      undo_story_read: {
        Args: { p_story_id: number }
        Returns: {
          first_read_at: string
          last_read_at: string
          read_count: number
        }[]
      }
      update_preferences: { Args: { p_patch: Json }; Returns: Json }
      update_story_content: {
        Args: { p_content: string; p_story_id: number }
        Returns: undefined
      }
      user_underused_kanji: {
        Args: { p_limit?: number }
        Returns: {
          exposures: number
          kanji: string
          last_read_at: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const


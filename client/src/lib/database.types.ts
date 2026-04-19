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
          preferred_content_type: string | null
          preferred_formality: string | null
          preferred_grammar_level: number | null
          preferred_model: string | null
          preferred_paragraphs: number | null
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          openrouter_api_key_secret_id?: string | null
          preferred_content_type?: string | null
          preferred_formality?: string | null
          preferred_grammar_level?: number | null
          preferred_model?: string | null
          preferred_paragraphs?: number | null
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          openrouter_api_key_secret_id?: string | null
          preferred_content_type?: string | null
          preferred_formality?: string | null
          preferred_grammar_level?: number | null
          preferred_model?: string | null
          preferred_paragraphs?: number | null
          user_id?: string
        }
        Relationships: []
      }
      stories: {
        Row: {
          allowed_kanji: string
          audio: Json | null
          content: string
          content_type: string
          created_at: string
          difficulty: Json
          filters: Json
          formality: string
          id: number
          paragraphs: number
          title: string
          topic: string | null
          user_id: string
        }
        Insert: {
          allowed_kanji: string
          audio?: Json | null
          content: string
          content_type?: string
          created_at?: string
          difficulty: Json
          filters: Json
          formality: string
          id?: never
          paragraphs: number
          title: string
          topic?: string | null
          user_id: string
        }
        Update: {
          allowed_kanji?: string
          audio?: Json | null
          content?: string
          content_type?: string
          created_at?: string
          difficulty?: Json
          filters?: Json
          formality?: string
          id?: never
          paragraphs?: number
          title?: string
          topic?: string | null
          user_id?: string
        }
        Relationships: []
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      clear_openrouter_api_key: { Args: never; Returns: undefined }
      get_openrouter_api_key_for_user: {
        Args: { p_user_id: string }
        Returns: string
      }
      get_user_kanji: {
        Args: never
        Returns: {
          character: string
          grade: number
          jlpt: number
          known: boolean
          meanings: string
          readings_kun: string
          readings_on: string
        }[]
      }
      set_openrouter_api_key: { Args: { p_key: string }; Returns: undefined }
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


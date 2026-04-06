-- Reference table: kanji (read-only for users, seeded by admin)
CREATE TABLE kanji (
  character TEXT PRIMARY KEY,
  grade INTEGER NOT NULL,
  jlpt INTEGER,
  meanings TEXT NOT NULL,
  readings_on TEXT NOT NULL,
  readings_kun TEXT NOT NULL
);

CREATE INDEX idx_kanji_grade ON kanji(grade);
CREATE INDEX idx_kanji_jlpt ON kanji(jlpt);

-- Per-user kanji known state
CREATE TABLE user_kanji (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  character TEXT NOT NULL REFERENCES kanji(character) ON DELETE CASCADE,
  known BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (user_id, character)
);

CREATE INDEX idx_user_kanji_user ON user_kanji(user_id);

-- Per-user stories
CREATE TABLE stories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  paragraphs INTEGER NOT NULL,
  topic TEXT,
  formality TEXT NOT NULL CHECK (formality IN ('impolite','casual','polite','keigo')),
  filters JSONB NOT NULL,
  allowed_kanji TEXT NOT NULL,
  difficulty JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stories_user ON stories(user_id);
CREATE INDEX idx_stories_created ON stories(created_at DESC);

-- User profiles (settings)
CREATE TABLE profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  openrouter_api_key TEXT,
  preferred_model TEXT DEFAULT 'deepseek/deepseek-r1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- RPC function: get kanji with per-user known state
CREATE OR REPLACE FUNCTION get_user_kanji(p_user_id UUID)
RETURNS TABLE (
  "character" TEXT,
  grade INTEGER,
  jlpt INTEGER,
  meanings TEXT,
  readings_on TEXT,
  readings_kun TEXT,
  known BOOLEAN
) AS $$
  SELECT k."character", k.grade, k.jlpt, k.meanings, k.readings_on, k.readings_kun,
         COALESCE(uk.known, false) AS known
  FROM kanji k
  LEFT JOIN user_kanji uk ON uk."character" = k."character" AND uk.user_id = p_user_id
  ORDER BY k.grade, k."character";
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- RLS Policies
ALTER TABLE kanji ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kanji readable by authenticated users"
  ON kanji FOR SELECT TO authenticated USING (true);

ALTER TABLE user_kanji ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own kanji state"
  ON user_kanji FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

ALTER TABLE stories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own stories"
  ON stories FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own profile"
  ON profiles FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

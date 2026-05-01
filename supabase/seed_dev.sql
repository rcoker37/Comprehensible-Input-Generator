-- Dev-only seed: a logged-in test user, a known-kanji baseline, and a
-- handful of sample stories. Runs after seed.sql via db.seed.sql_paths in
-- config.toml. Every insert is idempotent so re-running supabase start /
-- db reset is safe.
--
-- Test credentials: dev@local.test / devpassword
--
-- The OpenRouter API key is intentionally NOT seeded here. The Supabase
-- CLI seed phase has no way to inject host env vars into psql, and we
-- don't want a real key in git. Run `npm run seed:key` after start to
-- pull OPENROUTER_DEV_KEY from .env.local into the dev profile's vault
-- secret. See scripts/seed-dev-key.sh.

BEGIN;

-- 1. Auth user
-- GoTrue scans the *_token / email_change columns as `string`, not `*string`,
-- so they MUST be '' rather than NULL. Several have no DB default in the
-- auth schema, so we set them explicitly here.
INSERT INTO auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token,
  email_change_token_new, email_change,
  created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  '00000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'dev@local.test',
  crypt('devpassword', gen_salt('bf')),
  now(),
  jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
  jsonb_build_object('full_name', 'Dev User'),
  '', '', '', '',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

-- 2. Email identity (required for password login)
INSERT INTO auth.identities (
  user_id, identity_data, provider, provider_id,
  last_sign_in_at, created_at, updated_at
)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  jsonb_build_object(
    'sub', '00000000-0000-0000-0000-000000000001',
    'email', 'dev@local.test',
    'email_verified', true
  ),
  'email',
  '00000000-0000-0000-0000-000000000001',
  now(), now(), now()
)
ON CONFLICT DO NOTHING;

-- handle_new_user() trigger has now created the matching profiles row
-- with all the default preferences.

-- 3. Known-kanji baseline: all of grades 1-3 (~440 kanji)
INSERT INTO user_kanji (user_id, character, known)
SELECT
  '00000000-0000-0000-0000-000000000001'::uuid,
  character,
  true
FROM kanji
WHERE grade IN (1, 2, 3)
ON CONFLICT (user_id, character) DO NOTHING;

-- 4. Sample stories (only seed once for the dev user — survives re-runs
-- without duplicating; cleared and re-seeded on a full db reset).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM stories
     WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid
  ) THEN
    RETURN;
  END IF;

  INSERT INTO stories (
    user_id, title, content, content_type, paragraphs, topic, formality,
    filters, allowed_kanji, difficulty, audio, explanations, created_at
  ) VALUES
  -- Story 1: short story, polite
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '公園《こうえん》の犬《いぬ》',
    E'今日《きょう》は天気《てんき》がいいです。私《わたし》は朝《あさ》から公園《こうえん》に行《い》きました。\n\n公園《こうえん》には大《おお》きな白《しろ》い犬《いぬ》がいました。犬《いぬ》は元気《げんき》に走《はし》ったり、子供《こども》たちと遊《あそ》んだりしていました。\n\n夕方《ゆうがた》になって、犬《いぬ》は飼《か》い主《ぬし》と一緒《いっしょ》に家《いえ》に帰《かえ》りました。私《わたし》も家《いえ》に帰《かえ》りました。とても楽《たの》しい一日《いちにち》でした。',
    'story', 3, '動物', 'polite',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '今日天気私朝公園行大白犬元気走子供遊夕方飼主一緒家帰楽一日',
    '{"uniqueKanji": 25, "grade": {"max": 3, "avg": 1.7}, "jlpt": {"min": 4, "avg": 4.6}}'::jsonb,
    NULL,
    '{}'::jsonb,
    now() - interval '6 days'
  ),
  -- Story 2: short story, casual
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '学校《がっこう》の朝《あさ》',
    E'朝《あさ》七時《しちじ》、私《わたし》は学校《がっこう》に行《い》く時間《じかん》だ。\n\n母《はは》が「お弁当《べんとう》を持《も》った?」と聞《き》いた。私《わたし》は「うん」と答《こた》えた。\n\n外《そと》は晴《は》れていた。空《そら》は青《あお》くて、鳥《とり》が鳴《な》いていた。今日《きょう》もいい一日《いちにち》になりそうだ。',
    'story', 3, '学校', 'casual',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '朝七時私学校行時間母弁当持聞答外晴空青鳥鳴今日一日',
    '{"uniqueKanji": 22, "grade": {"max": 3, "avg": 1.9}, "jlpt": {"min": 4, "avg": 4.5}}'::jsonb,
    NULL,
    '{}'::jsonb,
    now() - interval '4 days'
  ),
  -- Story 3: short story, polite (already read)
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '雪《ゆき》の日《ひ》',
    E'冬《ふゆ》の朝《あさ》、目《め》が覚《さ》めると、外《そと》は真《ま》っ白《しろ》でした。雪《ゆき》がたくさん降《ふ》っていました。\n\n私《わたし》は窓《まど》から外《そと》を見《み》ました。木《き》や山《やま》、町《まち》のすべてが白《しろ》い色《いろ》でした。とても美《うつく》しかったです。\n\n弟《おとうと》と一緒《いっしょ》に外《そと》に出《で》て、雪《ゆき》だるまを作《つく》りました。寒《さむ》かったけれど、楽《たの》しかったです。',
    'story', 3, '冬', 'polite',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '冬朝目覚外真白雪降私見木山町色美弟一緒出作寒楽',
    '{"uniqueKanji": 22, "grade": {"max": 3, "avg": 2.1}, "jlpt": {"min": 3, "avg": 4.2}}'::jsonb,
    NULL,
    '{}'::jsonb,
    now() - interval '3 days'
  ),
  -- Story 4: dialogue, polite (keigo)
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    'レストランで',
    E'店員《てんいん》: いらっしゃいませ。何名様《なんめいさま》ですか。\n\n客《きゃく》: 二人《ふたり》です。\n\n店員《てんいん》: では、こちらへどうぞ。お飲《の》み物《もの》は何《なに》になさいますか。\n\n客《きゃく》: 水《みず》を二《ふた》つ、お願《ねが》いします。それから、メニューを見《み》せてください。\n\n店員《てんいん》: かしこまりました。少々《しょうしょう》お待《ま》ちください。',
    'dialogue', 5, '食事', 'keigo',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '店員何名様客二人飲物水願見少待',
    '{"uniqueKanji": 13, "grade": {"max": 3, "avg": 2.0}, "jlpt": {"min": 3, "avg": 4.0}}'::jsonb,
    NULL,
    '{}'::jsonb,
    now() - interval '2 days'
  ),
  -- Story 5: dialogue, casual
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '友達《ともだち》との会話《かいわ》',
    E'A: 明日《あした》、何《なに》する?\n\nB: 別《べつ》に。家《いえ》にいるかも。\n\nA: 一緒《いっしょ》に映画《えいが》を見《み》ない?\n\nB: いいね!何時《なんじ》から?\n\nA: 三時《さんじ》から。駅前《えきまえ》で会《あ》おう。',
    'dialogue', 5, '友達', 'casual',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '明日何別家一緒映画見時三駅前会',
    '{"uniqueKanji": 13, "grade": {"max": 3, "avg": 2.2}, "jlpt": {"min": 3, "avg": 4.1}}'::jsonb,
    NULL,
    '{}'::jsonb,
    now() - interval '1 days'
  ),
  -- Story 6: essay, polite (newest)
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '日本《にほん》の四季《しき》',
    E'日本《にほん》には、四《よっ》つの季節《きせつ》があります。春《はる》、夏《なつ》、秋《あき》、冬《ふゆ》です。それぞれが美《うつく》しい特色《とくしょく》を持《も》っています。\n\n春《はる》には桜《さくら》が咲《さ》きます。夏《なつ》は暑《あつ》くて、海《うみ》で泳《およ》ぐのが楽《たの》しいです。秋《あき》は木《き》の葉《は》が赤《あか》くなり、空《そら》も高《たか》くなります。冬《ふゆ》は雪《ゆき》が降《ふ》り、家《いえ》の中《なか》で温《あたた》かいお茶《ちゃ》を飲《の》みます。\n\n日本《にほん》の四季《しき》は、人《ひと》の心《こころ》を豊《ゆた》かにします。私《わたし》は四季《しき》のあるこの国《くに》が大好《だいす》きです。',
    'essay', 3, '季節', 'polite',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '日本四季春夏秋冬美特色持桜咲暑海泳楽木葉赤空高雪降家中温茶飲人心豊国大好私',
    '{"uniqueKanji": 33, "grade": {"max": 4, "avg": 2.4}, "jlpt": {"min": 3, "avg": 3.9}}'::jsonb,
    NULL,
    '{}'::jsonb,
    now() - interval '6 hours'
  );
END $$;

COMMIT;

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
    filters, allowed_kanji, difficulty, created_at
  ) VALUES
  -- Story 1: short story, polite
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '公園《こうえん》の犬《いぬ》',
    E'今日《きょう》は天気《てんき》がいいです。私《わたし》は朝《あさ》から公園《こうえん》に行《い》きました。\n\n公園《こうえん》には大《おお》きな白《しろ》い犬《いぬ》がいました。犬《いぬ》は元気《げんき》に走《はし》ったり、子供《こども》たちと遊《あそ》んだりしていました。\n\n夕方《ゆうがた》になって、犬《いぬ》は飼《か》い主《ぬし》と一緒《いっしょ》に家《いえ》に帰《かえ》りました。私《わたし》も家《いえ》に帰《かえ》りました。とても楽《たの》しい一日《いちにち》でした。',
    'fiction', 3, '動物', 'polite',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '今日天気私朝公園行大白犬元気走子供遊夕方飼主一緒家帰楽一日',
    '{"uniqueKanji": 25, "grade": {"max": 3, "avg": 1.7}, "jlpt": {"min": 4, "avg": 4.6}}'::jsonb,
    now() - interval '6 days'
  ),
  -- Story 2: short story, casual
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '学校《がっこう》の朝《あさ》',
    E'朝《あさ》七時《しちじ》、私《わたし》は学校《がっこう》に行《い》く時間《じかん》だ。\n\n母《はは》が「お弁当《べんとう》を持《も》った?」と聞《き》いた。私《わたし》は「うん」と答《こた》えた。\n\n外《そと》は晴《は》れていた。空《そら》は青《あお》くて、鳥《とり》が鳴《な》いていた。今日《きょう》もいい一日《いちにち》になりそうだ。',
    'fiction', 3, '学校', 'casual',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '朝七時私学校行時間母弁当持聞答外晴空青鳥鳴今日一日',
    '{"uniqueKanji": 22, "grade": {"max": 3, "avg": 1.9}, "jlpt": {"min": 4, "avg": 4.5}}'::jsonb,
    now() - interval '4 days'
  ),
  -- Story 3: short story, polite (already read)
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '雪《ゆき》の日《ひ》',
    E'冬《ふゆ》の朝《あさ》、目《め》が覚《さ》めると、外《そと》は真《ま》っ白《しろ》でした。雪《ゆき》がたくさん降《ふ》っていました。\n\n私《わたし》は窓《まど》から外《そと》を見《み》ました。木《き》や山《やま》、町《まち》のすべてが白《しろ》い色《いろ》でした。とても美《うつく》しかったです。\n\n弟《おとうと》と一緒《いっしょ》に外《そと》に出《で》て、雪《ゆき》だるまを作《つく》りました。寒《さむ》かったけれど、楽《たの》しかったです。',
    'fiction', 3, '冬', 'polite',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '冬朝目覚外真白雪降私見木山町色美弟一緒出作寒楽',
    '{"uniqueKanji": 22, "grade": {"max": 3, "avg": 2.1}, "jlpt": {"min": 3, "avg": 4.2}}'::jsonb,
    now() - interval '3 days'
  ),
  -- Story 4: dialogue, polite (keigo)
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    'レストランで',
    E'店員《てんいん》: いらっしゃいませ。何名様《なんめいさま》ですか。\n\n客《きゃく》: 二人《ふたり》です。\n\n店員《てんいん》: では、こちらへどうぞ。お飲《の》み物《もの》は何《なに》になさいますか。\n\n客《きゃく》: 水《みず》を二《ふた》つ、お願《ねが》いします。それから、メニューを見《み》せてください。\n\n店員《てんいん》: かしこまりました。少々《しょうしょう》お待《ま》ちください。',
    'fiction', 5, '食事', 'keigo',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '店員何名様客二人飲物水願見少待',
    '{"uniqueKanji": 13, "grade": {"max": 3, "avg": 2.0}, "jlpt": {"min": 3, "avg": 4.0}}'::jsonb,
    now() - interval '2 days'
  ),
  -- Story 5: dialogue, casual
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '友達《ともだち》との会話《かいわ》',
    E'A: 明日《あした》、何《なに》する?\n\nB: 別《べつ》に。家《いえ》にいるかも。\n\nA: 一緒《いっしょ》に映画《えいが》を見《み》ない?\n\nB: いいね!何時《なんじ》から?\n\nA: 三時《さんじ》から。駅前《えきまえ》で会《あ》おう。',
    'fiction', 5, '友達', 'casual',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '明日何別家一緒映画見時三駅前会',
    '{"uniqueKanji": 13, "grade": {"max": 3, "avg": 2.2}, "jlpt": {"min": 3, "avg": 4.1}}'::jsonb,
    now() - interval '1 days'
  ),
  -- Story 6: essay, polite (newest)
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '日本《にほん》の四季《しき》',
    E'日本《にほん》には、四《よっ》つの季節《きせつ》があります。春《はる》、夏《なつ》、秋《あき》、冬《ふゆ》です。それぞれが美《うつく》しい特色《とくしょく》を持《も》っています。\n\n春《はる》には桜《さくら》が咲《さ》きます。夏《なつ》は暑《あつ》くて、海《うみ》で泳《およ》ぐのが楽《たの》しいです。秋《あき》は木《き》の葉《は》が赤《あか》くなり、空《そら》も高《たか》くなります。冬《ふゆ》は雪《ゆき》が降《ふ》り、家《いえ》の中《なか》で温《あたた》かいお茶《ちゃ》を飲《の》みます。\n\n日本《にほん》の四季《しき》は、人《ひと》の心《こころ》を豊《ゆた》かにします。私《わたし》は四季《しき》のあるこの国《くに》が大好《だいす》きです。',
    'nonfiction', 3, '季節', 'polite',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '日本四季春夏秋冬美特色持桜咲暑海泳楽木葉赤空高雪降家中温茶飲人心豊国大好私',
    '{"uniqueKanji": 33, "grade": {"max": 4, "avg": 2.4}, "jlpt": {"min": 3, "avg": 3.9}}'::jsonb,
    now() - interval '6 hours'
  ),
  -- Story 7: essay, polite — regroup edge cases. Bundles the original
  -- 千九百年代 number-compound split, the にし|ます verb-aux split case,
  -- 食べました multi-token deinflection, には compound particle, te/ta-form
  -- chains, and several annotated-kanji + okurigana ku-form merges.
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '千九百年代《せんきゅうひゃくねんだい》の思《おも》い出《で》',
    E'私《わたし》のおじいさんは千九百年代に生《う》まれました。家族《かぞく》は四《よっ》つの部屋《へや》のある家《いえ》に住《す》んでいました。\n\nある日《ひ》、おじいさんは「もっとよい人《ひと》になります」と決《き》めました。空《そら》は高《たか》くなり、雲《くも》は白《しろ》かったです。家《いえ》に帰《かえ》って、母《はは》が作《つく》ったご飯《はん》を食《た》べました。\n\n日本《にほん》には四《よっ》つの季節《きせつ》があります。冬《ふゆ》には雪《ゆき》が降《ふ》り、夏《なつ》にはとても暑《あつ》くなります。そんな時《とき》のことを思《おも》い出《だ》すと、心《こころ》が温《あたた》かくなります。',
    'fiction', 3, '思い出', 'polite',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '千九百年代思出私生家族四部屋住日人決空高雲白帰母作飯食本季節冬雪降夏暑時心温',
    '{"uniqueKanji": 38, "grade": {"max": 6, "avg": 2.3}, "jlpt": {"min": 2, "avg": 4.0}}'::jsonb,
    now() - interval '1 hours'
  ),
  -- Story 8: deinflection regression — repeated kana-only いきます.
  -- Tap target for confirming いきます resolves to いく (to go), not
  -- いきむ (息む, to strain). The short-causative rule (ます→む) used
  -- to win on first-hit-wins because it appears earlier in the
  -- transform list; deinflect() now ranks by consumed-suffix length
  -- so the polite -ます rule (きます→く) wins.
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    'こうえんにいきます',
    E'明日《あした》、友達《ともだち》と公園《こうえん》にいきます。雨《あめ》がふっても、いきます。\n\n朝《あさ》ごはんを食《た》べてから、駅《えき》までいきます。みんなで元気《げんき》にいきましょう。\n\n弟《おとうと》も「いっしょにいきたい」と言《い》いました。だから、家族《かぞく》みんなでいきます。',
    'fiction', 3, '日常', 'polite',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '明日友達公園雨朝食駅元気弟言家族',
    '{"uniqueKanji": 13, "grade": {"max": 3, "avg": 2.0}, "jlpt": {"min": 4, "avg": 4.5}}'::jsonb,
    now() - interval '30 minutes'
  ),
  -- Story 9: continuative + comma chains. Every paragraph stacks several
  -- 連用形 verbs before commas (降り、吹き、向かい、止み、消え、なり、
  -- 帰り、飲み、読み、…) — including the canonical 〜くなり、 pattern
  -- where JMdict has unrelated kana entries for なり that used to shadow
  -- the deinflection to なる. lookupAtBoundary's kuromoji-POS-hinted
  -- path should now resolve every one of these to its dictionary form.
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '秋《あき》の一日《いちにち》',
    E'ある朝《あさ》、雨《あめ》が降《ふ》り、風《かぜ》が吹《ふ》き、空《そら》は灰色《はいいろ》になりました。木《き》の葉《は》は赤《あか》くなり、黄色《きいろ》くなり、下《した》に落《お》ちました。\n\n私《わたし》は家《いえ》を出《で》て、駅《えき》に向《む》かい、電車《でんしゃ》に乗《の》り、町《まち》に行《い》きました。\n\n午後《ごご》、雨《あめ》が止《や》み、雲《くも》が消《き》え、空《そら》は青《あお》くなり、心《こころ》も明《あか》るくなりました。\n\n家《いえ》に帰《かえ》り、お茶《ちゃ》を飲《の》み、本《ほん》を読《よ》み、静《しず》かな夜《よる》を過《す》ごしました。',
    'fiction', 4, '一日', 'polite',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '秋一日朝雨降風吹空灰色木葉赤黄下落私家出駅向電車乗町行午後止雲消青心明帰茶飲本読静夜過',
    '{"uniqueKanji": 41, "grade": {"max": 6, "avg": 2.5}, "jlpt": {"min": 2, "avg": 4.1}}'::jsonb,
    now() - interval '10 minutes'
  ),
  -- Story 10: homophone disambiguation via JMdict entry id.
  --   * 暗《くら》い appears as kanji — the i-adjective "dark" (JMdict id
  --     1154330, JPDB rank 881). Previously the popover would substitute
  --     くらい as the "most common spelling" because くらい outranks 暗い
  --     in JPDB — but the rank belonged to a different lexeme.
  --   * くらい appears as a kana-only approximation suffix (id 1154340,
  --     rank 189) — a separate JMdict entry from 暗い. Tapping it should
  --     show suffix senses, not "dark".
  --   * 貴方《あなた》 — the "you" pronoun entry (id 1223615) carries
  --     `uk` on its senses, so the resolved display headword is あなた
  --     (rank 121) instead of the canonical kanji 貴方 (rank 3,151).
  --     The scoring path picks up the entry-resolved rank too.
  (
    '00000000-0000-0000-0000-000000000001'::uuid,
    '暗《くら》い部屋《へや》',
    E'夕方《ゆうがた》、部屋《へや》の中《なか》は暗《くら》くなりました。私《わたし》は窓《まど》から空《そら》を見《み》て、星《ほし》が三《みっ》つくらい数《かぞ》えました。\n\n「貴方《あなた》、ご飯《はん》ですよ」と母《はは》の声《こえ》が聞《き》こえました。私《わたし》は「今《いま》行《い》きます」と答《こた》えました。\n\n台所《だいどころ》で母《はは》は「今日《きょう》は何時《なんじ》くらいに帰《かえ》りましたか」と聞《き》きました。私《わたし》は「六時《ろくじ》くらいです」と答《こた》えました。外《そと》はもう暗《くら》かったです。',
    'fiction', 3, '夕方', 'polite',
    '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
    '暗部屋夕方中私窓空見星三数貴飯母声聞今日行答台所何時帰六外',
    '{"uniqueKanji": 29, "grade": {"max": 6, "avg": 2.4}, "jlpt": {"min": 1, "avg": 3.6}}'::jsonb,
    now() - interval '5 minutes'
  );
END $$;

COMMIT;

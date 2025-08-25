import express from "express";
import cors from "cors";
import pkg from "pg";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
const { Pool } = pkg;

const app = express();
app.use(cors({
  origin: "https://mypixiv-front.vercel.app", // フロントのURLを指定
  credentials: true,
}));
app.use(express.json());

// Neon(PostgreSQL) DB接続
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// APIで次のことができる。
// ユーザー登録 /api/users
// 作品登録 /api/works
// タグ付き検索 /api/search
// 作品削除 /api/works/:id

//環境変数がrenderで設定されているかのチェック
console.log("JWT_SECRET:", process.env.JWT_SECRET ? "✅ 設定済" : "❌ 未設定");

//認証ミドルウェア
function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(401).json({ error: "認証が必要です" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // userId を格納
    next();
  } catch (err) {
    return res.status(401).json({ error: "トークン無効" });
  }
}


// ================= ユーザー登録 & ログイン =================
app.post("/api/signup", async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id",
      [username, hash]
    );

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "1h" });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);

    if (result.rows.length === 0) return res.status(401).json({ error: "ユーザーが存在しません" });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) return res.status(401).json({ error: "パスワードが違います" });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: "1h" });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


// 作品追加
app.post("/api/works", authMiddleware, async (req, res) => {
  try {
    const { pixivId, title, type, tags } = req.body;
    const userId = req.user.userId; // ← JWTから取得

    console.log("受け取ったデータ:", req.body);

    // works追加
    const workResult = await pool.query(
      "INSERT INTO works (user_id, pixiv_id, title, type) VALUES ($1, $2, $3, $4) RETURNING id",
      [userId, pixivId, title, type]
    );
    const workId = workResult.rows[0].id;

    console.log("作成したworkId:", workId);

    if (!tags || tags.length === 0) {
      console.log("⚠ タグが空のためスキップ");
    } else {
      for (const tag of tags) {
        console.log("処理中のタグ:", tag);

        let tagResult = await pool.query("SELECT id FROM tags WHERE name = $1", [tag]);
        let tagId;
        if (tagResult.rows.length === 0) {
          const insertTag = await pool.query(
            "INSERT INTO tags (name) VALUES ($1) RETURNING id",
            [tag]
          );
          tagId = insertTag.rows[0].id;
          console.log("新規タグ追加:", tag, "→ id:", tagId);
        } else {
          tagId = tagResult.rows[0].id;
          console.log("既存タグ使用:", tag, "→ id:", tagId);
        }

        await pool.query(
          "INSERT INTO work_tags (work_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [workId, tagId]
        );
        console.log("work_tags に追加:", workId, tagId);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ エラー発生:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// 検索
app.post("/api/search",authMiddleware, async (req, res) => {
  try {
    const { type, tags } = req.body;
    const userId = req.user.userId; // JWTから取得

    // 基本の条件
    let params = [type, userId];

    // SQL文
    let query = `
      SELECT w.id,
             w.pixiv_id,
             w.title,
             w.type,
             COALESCE(json_agg(t.name) FILTER (WHERE t.id IS NOT NULL), '[]') AS tags
      FROM works w
      LEFT JOIN work_tags wt ON w.id = wt.work_id
      LEFT JOIN tags t ON wt.tag_id = t.id
      WHERE w.type = $1 AND w.user_id = $2
    `;

  // タグ指定がある場合
  //AND検索
  if (tags && tags.length > 0) {
    query += `
      HAVING (
        SELECT COUNT(DISTINCT t2.name)
        FROM work_tags wt2
        JOIN tags t2 ON wt2.tag_id = t2.id
        WHERE wt2.work_id = w.id
          AND t2.name = ANY($3::text[])
      ) = array_length($3::text[], 1)
    `;
    params.push(tags);
  }

    query += `
      GROUP BY w.id
      ORDER BY w.id DESC
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// タグサジェスト（前方一致）
app.get("/api/tags", async (req, res) => {
  try {
    const q = req.query.q || "";
    const result = await pool.query(
      `SELECT name FROM tags WHERE name ILIKE $1 ORDER BY name LIMIT 10`,
      [`${q}%`]  // ← 前方一致
    );
    res.json(result.rows.map(r => r.name));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


// 作品削除
app.delete("/api/works/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId; // JWTから

    const result = await pool.query(
      "DELETE FROM works WHERE id = $1 AND user_id = $2",
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Not found or not authorized" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});



app.listen(3000, () => console.log(`Server running on port 3000`));

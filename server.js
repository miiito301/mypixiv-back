import express from "express";
import cors from "cors";
import pkg from "pg";
const { Pool } = pkg;

const app = express();
app.use(cors());
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

// 作品追加
app.post("/api/works", async (req, res) => {
  try {
    const { userId, pixivId, title, type, tags } = req.body;

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
app.post("/api/search", async (req, res) => {
  try {
    const { type, tags, userId } = req.body;

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
    if (tags && tags.length > 0) {
      // → EXISTS で「作品に指定タグが含まれているか」を判定
      query += `
        AND EXISTS (
          SELECT 1
          FROM work_tags wt2
          JOIN tags t2 ON wt2.tag_id = t2.id
          WHERE wt2.work_id = w.id
            AND t2.name = ANY($3::text[])
        )
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


// 作品削除
app.delete("/api/works/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;

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

// ユーザー登録
app.post("/api/users", async (req, res) => {
  try {
    const { username } = req.body;
    const result = await pool.query(
      "INSERT INTO users (username) VALUES ($1) RETURNING id, username",
      [username]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.listen(3000, () => console.log("Server running on http://localhost:3000"));


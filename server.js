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

    // works追加
    const workResult = await pool.query(
      "INSERT INTO works (user_id, pixiv_id, title, type) VALUES ($1, $2, $3, $4) RETURNING id",
      [userId, pixivId, title, type]
    );
    const workId = workResult.rows[0].id;

    // tags追加
    for (const tag of tags) {
      let tagResult = await pool.query("SELECT id FROM tags WHERE name = $1", [tag]);
      let tagId;
      if (tagResult.rows.length === 0) {
        const insertTag = await pool.query("INSERT INTO tags (name) VALUES ($1) RETURNING id", [tag]);
        tagId = insertTag.rows[0].id;
      } else {
        tagId = tagResult.rows[0].id;
      }

      await pool.query(
        "INSERT INTO work_tags (work_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [workId, tagId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 検索
app.post("/api/search", async (req, res) => {
  try {
    const { type, tags, userId } = req.body;

    let query = `
      SELECT DISTINCT w.*
      FROM works w
      LEFT JOIN work_tags wt ON w.id = wt.work_id
      LEFT JOIN tags t ON wt.tag_id = t.id
      WHERE w.type = $1 AND w.user_id = $2
    `;
    const params = [type, userId];

    if (tags && tags.length > 0) {
      const placeholders = tags.map((_, i) => `$${i + 3}`).join(",");
      query += ` AND t.name IN (${placeholders})`;
      params.push(...tags);
    }

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


const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const ffmpegPath = "ffmpeg"; // Pastikan ffmpeg sudah terinstall di sistem
const db = require("../models/database");
const logger = require("../utils/logger");
const router = express.Router();

// Gunakan memory storage untuk buffer chunk sementara
const upload = multer({ storage: multer.memoryStorage() });

// Helper untuk membuat folder jika belum ada
const ensureDir = (dir) => {
   if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

// ROUTE 1: Menerima Potongan File (Chunk)
router.post("/local/chunk", upload.single("chunk"), (req, res) => {
   try {
      const { fileId, chunkIndex } = req.body;
      const buffer = req.file.buffer;

      const tempDir = path.join(process.env.UPLOAD_PATH || "public/uploads", "temp", fileId);
      ensureDir(tempDir);

      const chunkPath = path.join(tempDir, `part-${chunkIndex}`);
      fs.writeFileSync(chunkPath, buffer);

      res.json({ message: "Chunk uploaded" });
   } catch (error) {
      logger.error(`Upload Chunk Error: ${error.message}`);
      res.status(500).json({ message: "Chunk upload failed" });
   }
});

// ROUTE 2: Finalisasi & Penggabungan (Merge)
router.post("/local/complete", async (req, res) => {
   const { fileId, fileName, totalChunks, title } = req.body;
   const uploadPath = process.env.UPLOAD_PATH || "public/uploads";
   const tempDir = path.join(uploadPath, "temp", fileId);
   const finalFilePath = path.join(uploadPath, fileName);

   try {
      // 1. Gabungkan semua chunk
      const writeStream = fs.createWriteStream(finalFilePath);

      for (let i = 0; i < totalChunks; i++) {
         const chunkPath = path.join(tempDir, `part-${i}`);
         if (!fs.existsSync(chunkPath)) {
            throw new Error(`Missing chunk ${i}`);
         }
         const data = fs.readFileSync(chunkPath);
         writeStream.write(data);
         fs.unlinkSync(chunkPath); // Hapus chunk setelah digabung
      }

      writeStream.end();

      writeStream.on("finish", () => {
         // Hapus folder temp
         fs.rmdirSync(tempDir);

         // 2. Generate Thumbnail & Save DB
         processVideo(finalFilePath, fileName, title, res);
      });
   } catch (error) {
      logger.error(`Merge Error: ${error.message}`);
      // Bersihkan jika gagal
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      res.status(500).json({ message: "Merge failed: " + error.message });
   }
});

function processVideo(filePath, fileName, title, res) {
   const thumbnailDir = path.join(process.env.UPLOAD_PATH || "public/uploads", "thumbnails");
   const thumbnailName = `${path.basename(fileName, path.extname(fileName))}.jpg`;
   const thumbnailPath = path.join(thumbnailDir, thumbnailName);

   ensureDir(thumbnailDir);

   // Command FFmpeg untuk thumbnail
   const cmd = `${ffmpegPath} -i "${filePath}" -ss 00:00:01 -vframes 1 "${thumbnailPath}" -y`;

   exec(cmd, (err) => {
      let finalThumb = null;
      if (err) {
         logger.error(`Thumbnail failed: ${err.message}`);
      } else {
         finalThumb = thumbnailName;
      }

      // Simpan ke Database
      db.run(
         "INSERT INTO videos (title, filename, thumbnail, views) VALUES (?, ?, ?, 0)",
         [title, fileName, finalThumb],
         function (err) {
            if (err) {
               logger.error("Database Insert Error: " + err.message);
               return res.status(500).json({ message: "DB Error" });
            }
            res.json({ message: "Upload Complete", videoId: this.lastID });
         },
      );
   });
}

module.exports = router;

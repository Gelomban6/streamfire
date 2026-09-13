const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const ffmpegPath = "ffmpeg";
const db = require("../models/database");
const logger = require("../utils/logger");
const router = express.Router();

const upload = multer({
   storage: multer.memoryStorage(),
   limits: { fileSize: 10 * 1024 * 1024 }
});

const ensureDir = (dir) => {
   if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

// Purge temporary chunk folders older than 24 hours to prevent disk exhaustion
const cleanAbandonedChunks = () => {
   const tempRoot = path.join(process.env.UPLOAD_PATH || "public/uploads", "temp");
   if (!fs.existsSync(tempRoot)) return;

   const now = Date.now();
   const maxAgeMs = 24 * 60 * 60 * 1000;

   fs.readdir(tempRoot, { withFileTypes: true }, (err, entries) => {
      if (err) return;
      entries.forEach((entry) => {
         if (entry.isDirectory()) {
            const folderPath = path.join(tempRoot, entry.name);
            fs.stat(folderPath, (statErr, stats) => {
               if (!statErr && now - stats.mtimeMs > maxAgeMs) {
                  fs.rm(folderPath, { recursive: true, force: true }, () => {});
               }
            });
         }
      });
   });
};

setInterval(cleanAbandonedChunks, 6 * 60 * 60 * 1000);

router.post("/local/chunk", upload.single("chunk"), (req, res) => {
   try {
      const { fileId, chunkIndex } = req.body;
      if (!req.file || !req.file.buffer) {
         return res.status(400).json({ message: "Missing chunk buffer" });
      }

      if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
         return res.status(400).json({ message: "Invalid file identifier" });
      }

      const parsedIndex = parseInt(chunkIndex, 10);
      if (isNaN(parsedIndex) || parsedIndex < 0 || parsedIndex > 10000) {
         return res.status(400).json({ message: "Invalid chunk index" });
      }

      const baseUploadPath = path.resolve(process.env.UPLOAD_PATH || "public/uploads");
      const tempDir = path.join(baseUploadPath, "temp", fileId);
      if (!tempDir.startsWith(baseUploadPath)) {
         return res.status(400).json({ message: "Invalid path destination" });
      }

      ensureDir(tempDir);

      const chunkPath = path.join(tempDir, `part-${parsedIndex}`);
      fs.writeFileSync(chunkPath, req.file.buffer);

      res.json({ message: "Chunk uploaded" });
   } catch (error) {
      logger.error(`Upload Chunk Error: ${error.message}`);
      res.status(500).json({ message: "Chunk upload failed" });
   }
});

const mergeChunksStream = (tempDir, totalChunks, finalFilePath) => {
   return new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(finalFilePath);
      let current = 0;

      const appendNext = () => {
         if (current >= totalChunks) {
            writeStream.end();
            return;
         }

         const chunkPath = path.join(tempDir, `part-${current}`);
         if (!fs.existsSync(chunkPath)) {
            writeStream.destroy();
            return reject(new Error(`Missing chunk ${current}`));
         }

         const readStream = fs.createReadStream(chunkPath);
         readStream.on("error", (err) => {
            writeStream.destroy();
            reject(err);
         });

         readStream.on("end", () => {
            fs.unlink(chunkPath, () => {});
            current++;
            appendNext();
         });

         readStream.pipe(writeStream, { end: false });
      };

      writeStream.on("finish", resolve);
      writeStream.on("error", reject);

      appendNext();
   });
};

router.post("/local/complete", async (req, res) => {
   const { fileId, fileName, totalChunks, title } = req.body;

   if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      return res.status(400).json({ message: "Invalid file identifier" });
   }

   const parsedTotal = parseInt(totalChunks, 10);
   if (isNaN(parsedTotal) || parsedTotal <= 0 || parsedTotal > 10000) {
      return res.status(400).json({ message: "Invalid chunk total" });
   }

   if (!fileName || typeof fileName !== "string") {
      return res.status(400).json({ message: "Invalid file name" });
   }

   const ext = path.extname(fileName).toLowerCase();
   const allowedExts = [".mp4", ".mkv", ".mov", ".flv"];
   if (!allowedExts.includes(ext)) {
      return res.status(400).json({ message: "File format not allowed" });
   }

   const baseUploadPath = path.resolve(process.env.UPLOAD_PATH || "public/uploads");
   const tempDir = path.join(baseUploadPath, "temp", fileId);
   if (!tempDir.startsWith(baseUploadPath)) {
      return res.status(400).json({ message: "Invalid temporary directory" });
   }

   const sanitizedBase = path.basename(fileName, ext).replace(/[^a-zA-Z0-9_-]/g, "_");
   const safeFileName = `${Date.now()}-${sanitizedBase}${ext}`;
   const finalFilePath = path.join(baseUploadPath, safeFileName);

   try {
      await mergeChunksStream(tempDir, parsedTotal, finalFilePath);
      fs.rm(tempDir, { recursive: true, force: true }, () => {});
      processVideo(finalFilePath, safeFileName, title, res);
   } catch (error) {
      logger.error(`Merge Error: ${error.message}`);
      if (fs.existsSync(finalFilePath)) fs.unlinkSync(finalFilePath);
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      res.status(500).json({ message: "Merge failed: " + error.message });
   }
});

function processVideo(filePath, fileName, title, res) {
   const baseUploadPath = path.resolve(process.env.UPLOAD_PATH || "public/uploads");
   const thumbnailDir = path.join(baseUploadPath, "thumbnails");
   const thumbnailName = `${path.basename(fileName, path.extname(fileName))}.jpg`;
   const thumbnailPath = path.join(thumbnailDir, thumbnailName);

   ensureDir(thumbnailDir);

   const safeTitle = typeof title === "string" && title.trim().length > 0 ? title.trim() : path.basename(fileName);

   // Input seeking (-ss before -i) parses keyframes in container header without decoding the entire video
   const ffmpegArgs = ["-ss", "00:00:01", "-i", filePath, "-vframes", "1", thumbnailPath, "-y"];
   const proc = spawn(ffmpegPath, ffmpegArgs);

   let stderrLog = "";
   proc.stderr.on("data", (data) => {
      stderrLog += data.toString();
   });

   proc.on("close", (code) => {
      let finalThumb = null;
      if (code !== 0) {
         logger.error(`Thumbnail generation exited with code ${code}: ${stderrLog.slice(-200)}`);
      } else {
         finalThumb = thumbnailName;
      }

      db.run(
         "INSERT INTO videos (title, filename, thumbnail, views) VALUES (?, ?, ?, 0)",
         [safeTitle, fileName, finalThumb],
         function (err) {
            if (err) {
               logger.error("Database Insert Error: " + err.message);
               return res.status(500).json({ message: "DB Error" });
            }
            res.json({ message: "Upload Complete", videoId: this.lastID });
         }
      );
   });

   proc.on("error", (err) => {
      logger.error(`FFmpeg spawn error: ${err.message}`);
      db.run(
         "INSERT INTO videos (title, filename, thumbnail, views) VALUES (?, ?, NULL, 0)",
         [safeTitle, fileName],
         function (insertErr) {
            if (insertErr) {
               return res.status(500).json({ message: "DB Error" });
            }
            res.json({ message: "Upload Complete", videoId: this.lastID });
         }
      );
   });
}

module.exports = router;

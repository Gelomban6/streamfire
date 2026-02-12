const express = require("express");
const path = require("path");
const fs = require("fs");
const db = require("../models/database");
const logger = require("../utils/logger");
const router = express.Router();

router.delete("/:id", (req, res) => {
   const videoId = req.params.id;

   db.get("SELECT filename, thumbnail FROM videos WHERE id = ?", [videoId], (err, row) => {
      if (err) {
         logger.error(`Database error finding video ${videoId}: ${err.message}`);
         return res.status(500).json({ message: "Database error" });
      }

      if (!row) {
         logger.error(`Video not found with ID ${videoId}`);
         return res.status(404).json({ message: "Video not found" });
      }

      if (global.streamProcesses[videoId]) {
         try {
            global.streamProcesses[videoId].proc.kill("SIGKILL");
            delete global.streamProcesses[videoId];
            global.io.emit("streamStatus", { videoId, running: false });
         } catch (e) {
            logger.error(`Error killing process for video ${videoId}: ${e}`);
         }
      }

      const uploadDir = path.join(__dirname, "../../public/uploads");

      if (row.filename) {
         const fullPath = path.join(uploadDir, row.filename);
         if (fs.existsSync(fullPath)) {
            fs.unlink(fullPath, (err) => {
               if (err) logger.error(`Error deleting file ${fullPath}: $(err)`);
            });
         }
      }

      if (row.thumbnail) {
         let thumbPath = row.thumbnail;
         if (!path.isAbsolute(thumbPath)) {
            thumbPath = path.join(__dirname, "../../public", row.thumbnail);
         }
         if (fs.existsSync(thumbPath)) {
            fs.unlink(thumbPath, (err) => {
               if (err) logger.error(`Error deleting thumbnail ${thumbPath}: ${err}`);
            });
         }
      }

      db.run("DELETE FROM videos WHERE id = ?", [videoId], (err) => {
         if (err) {
            logger.error(`Error deleting video ${videoId} from database: ${err}`);
            return res.status(500).json({ message: "Failed to delete video" });
         }
         logger.info(`Video ${videoId} deleted successfully`);
         res.json({ message: "Video deleted successfully" });
      });
   });
});

module.exports = router;

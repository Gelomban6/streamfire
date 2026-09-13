const ffmpeg = "ffmpeg";
const { spawn } = require("child_process");
const logger = require("../utils/logger");
const fs = require("fs");
const path = require("path");
const db = require("../models/database");

const ALLOWED_RESOLUTIONS = {
   "852x480": [852, 480],
   "1280x720": [1280, 720],
   "1920x1080": [1920, 1080]
};

const ALLOWED_FPS = ["24", "30", "60"];
const ALLOWED_BITRATES = ["2500k", "4500k", "6000k"];

function isValidRtmpUrl(url) {
   if (typeof url !== "string") return false;
   // Ensure only valid rtmp/rtmps URLs without tee muxer control characters
   if (!/^rtmps?:\/\/[a-zA-Z0-9.-]+(:\d+)?(\/[a-zA-Z0-9._~:/?#@!$&'()*+,;=-]*)?$/.test(url)) {
      return false;
   }
   if (url.includes("|") || url.includes("[") || url.includes("]")) {
      return false;
   }
   return true;
}

function startStream(
   videoPath,
   settings = { bitrate: "2500k", resolution: "1280x720", fps: "30" },
   loop = false,
   customRtmp
) {
   let absolutePath = videoPath;
   if (!fs.existsSync(absolutePath)) {
      absolutePath = path.resolve(process.cwd(), videoPath);
   }

   if (!fs.existsSync(absolutePath)) {
      logger.error(`FATAL: Video missing: ${absolutePath}`);
      return null;
   }

   const bitrate = ALLOWED_BITRATES.includes(settings.bitrate) ? settings.bitrate : "2500k";
   const fps = ALLOWED_FPS.includes(String(settings.fps)) ? String(settings.fps) : "30";
   const bufSize = parseInt(bitrate, 10) * 2 + "k";

   const targetRes = ALLOWED_RESOLUTIONS[settings.resolution] ? settings.resolution : "1280x720";
   const [w, h] = ALLOWED_RESOLUTIONS[targetRes] || [1280, 720];

   const vfFilter = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`;

   const rtmpList = Array.isArray(customRtmp) ? customRtmp : [customRtmp];
   const validRtmps = rtmpList.filter(isValidRtmpUrl);

   if (validRtmps.length === 0) {
      logger.error("Failed to start stream: No valid RTMP destinations supplied.");
      return null;
   }

   const outputs = validRtmps.map((url) => `[f=flv:onfail=ignore]${url}`);
   const destinationStr = outputs.join("|");

   const args = [
      "-re",
      ...(loop ? ["-stream_loop", "-1"] : []),
      "-thread_queue_size", "512",
      "-i", absolutePath,
      "-threads", "1",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-tune", "zerolatency",
      "-profile:v", "baseline",
      "-b:v", bitrate,
      "-maxrate", bitrate,
      "-minrate", bitrate,
      "-bufsize", bufSize,
      "-pix_fmt", "yuv420p",
      "-g", (parseInt(fps, 10) * 2).toString(),
      "-r", fps,
      "-vf", vfFilter,
      "-c:a", "aac",
      "-ac", "2",
      "-ar", "44100",
      "-b:a", "128k",
      "-f", "tee",
      "-map", "0:v",
      "-map", "0:a",
      destinationStr
   ];

   logger.info(`System FFmpeg Start: ${w}x${h} @ ${fps}fps to ${validRtmps.length} target(s)`);

   const proc = spawn(ffmpeg, args);
   let lastLog = "";

   proc.stderr.on("data", (data) => {
      lastLog = data.toString();
   });

   proc.on("close", (code, signal) => {
      if (code !== 0 && code !== 255 && signal !== "SIGTERM") {
         logger.error(`FFmpeg Error (${signal || code}). Log: ${lastLog.slice(-300)}`);
      } else {
         logger.info(`Stream stopped.`);
      }

      for (let videoId in global.streamProcesses) {
         if (global.streamProcesses[videoId].pid === proc.pid) {
            delete global.streamProcesses[videoId];
            db.run("UPDATE videos SET start_time = NULL WHERE id = ?", [videoId]);
            global.io.emit("streamStatus", { videoId, running: false });
            break;
         }
      }
   });

   return proc;
}

module.exports = { startStream, isValidRtmpUrl };

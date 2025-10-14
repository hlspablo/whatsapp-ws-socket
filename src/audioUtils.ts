import { exec } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";

/**
 * Process audio file for voice notes (ptt: true)
 * Convert to OGG/Opus with single channel and recommended flags for WA compatibility
 */
export const processAudio = async (audio: string): Promise<string> => {
  const outputAudio = path.join(os.tmpdir(), `${new Date().getTime()}.ogg`);
  console.log(`Processing audio file ${audio} to ${outputAudio}`);

  return new Promise((resolve, reject) => {
    exec(
      `${ffmpegPath.path} -i ${audio} -vn -ar 48000 -ac 1 -c:a libopus -b:a 64k -application voip -avoid_negative_ts make_zero -map_metadata -1 -f ogg ${outputAudio} -y`,
      (error, _stdout, stderr) => {
        if (error) {
          console.error(`Error processing audio: ${error.message}`);
          console.error(`ffmpeg stderr: ${stderr}`);
          reject(error);
          return;
        }

        console.log(`Audio successfully processed to ${outputAudio}`);

        // Clean up original file if it exists and is a temporary file
        if (fs.existsSync(audio) && audio.includes(os.tmpdir())) {
          fs.unlinkSync(audio);
        }

        resolve(outputAudio);
      }
    );
  });
};

/**
 * Process audio file for regular audio messages (ptt: false)
 * Convert to OGG/Opus with single channel and recommended flags for WA compatibility
 */
export const processAudioFile = async (audio: string): Promise<string> => {
  const outputAudio = path.join(os.tmpdir(), `${new Date().getTime()}.ogg`);
  console.log(`Processing regular audio file ${audio} to ${outputAudio}`);

  return new Promise((resolve, reject) => {
    exec(
      `${ffmpegPath.path} -i ${audio} -vn -ar 48000 -ac 1 -c:a libopus -b:a 96k -avoid_negative_ts make_zero -map_metadata -1 -f ogg ${outputAudio} -y`,
      (error, _stdout, stderr) => {
        if (error) {
          console.error(`Error processing audio file: ${error.message}`);
          console.error(`ffmpeg stderr: ${stderr}`);
          reject(error);
          return;
        }

        console.log(`Regular audio successfully processed to ${outputAudio}`);

        // Clean up original file if it exists and is a temporary file
        if (fs.existsSync(audio) && audio.includes(os.tmpdir())) {
          fs.unlinkSync(audio);
        }

        resolve(outputAudio);
      }
    );
  });
};

/**
 * Determine if an audio should be treated as a voice note
 * Based on filename patterns and mimetype
 */
export const isVoiceNote = (filename?: string, mimetype?: string): boolean => {
  if (filename && filename.includes("audio-record-site")) {
    return true;
  }
  
  if (mimetype === "audio/ogg" || mimetype === "audio/opus") {
    return true;
  }
  
  if (filename && (filename.endsWith('.ogg') || filename.endsWith('.opus'))) {
    return true;
  }
  
  return false;
};

/**
 * Process video file for WhatsApp compatibility
 * Converts video to MP4 format with H.264 codec and generates thumbnail
 */
export const processVideo = async (video: string): Promise<string> => {
  const outputVideo = path.join(os.tmpdir(), `${new Date().getTime()}.mp4`);
  console.log(`Processing video file ${video} to ${outputVideo}`);
  
  return new Promise((resolve, reject) => {
    exec(
      `${ffmpegPath.path} -i ${video} -c:v libx264 -c:a aac -preset fast -crf 23 -maxrate 3000k -bufsize 6000k -vf "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2" -movflags +faststart -y ${outputVideo}`,
      (error, _stdout, stderr) => {
        if (error) {
          console.error(`Error processing video: ${error.message}`);
          console.error(`ffmpeg stderr: ${stderr}`);
          reject(error);
          return;
        }
        
        console.log(`Video successfully processed to ${outputVideo}`);
        
        // Clean up original file if it exists and is a temporary file
        if (fs.existsSync(video) && video.includes(os.tmpdir())) {
          fs.unlinkSync(video);
        }
        
        resolve(outputVideo);
      }
    );
  });
};

/**
 * Generate video thumbnail
 */
export const generateVideoThumbnail = async (video: string): Promise<string> => {
  const outputThumbnail = path.join(os.tmpdir(), `${new Date().getTime()}_thumb.jpg`);
  console.log(`Generating thumbnail for video ${video} to ${outputThumbnail}`);
  
  return new Promise((resolve, reject) => {
    exec(
      `${ffmpegPath.path} -i ${video} -ss 00:00:01 -vframes 1 -f image2 -q:v 2 ${outputThumbnail} -y`,
      (error, _stdout, stderr) => {
        if (error) {
          console.error(`Error generating thumbnail: ${error.message}`);
          console.error(`ffmpeg stderr: ${stderr}`);
          reject(error);
          return;
        }
        
        console.log(`Thumbnail successfully generated: ${outputThumbnail}`);
        resolve(outputThumbnail);
      }
    );
  });
};

/**
 * Clean up temporary files
 */
export const cleanupTempFile = (filePath: string): void => {
  try {
    if (fs.existsSync(filePath) && filePath.includes(os.tmpdir())) {
      fs.unlinkSync(filePath);
      console.log(`Cleaned up temp file: ${filePath}`);
    }
  } catch (error) {
    console.error(`Error cleaning up temp file ${filePath}:`, error);
  }
}; 
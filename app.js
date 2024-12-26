import { Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import sharp from "sharp";

dotenv.config();

// grid configuration
const thumbSize = 100;
const gridWidth = 3;
const spacing = 10;

async function processThumbnails(response) {
  const images = await Promise.all(
    response.picker.map(async (item) => {
      try {
        const { data: imageBuffer } = await axios({
          url: item.thumb,
          responseType: 'arraybuffer'
        });

        return sharp(imageBuffer)
          .resize(thumbSize, thumbSize)
          .toBuffer();
      } catch (error) {
        console.error(`Failed to process ${item.thumb}: ${error}`);
        return null;
      }
    })
  );

  const validImages = images.filter(Boolean);

  const rows = Math.ceil(validImages.length / gridWidth);

  const compositeImages = validImages.map((imgBuffer, index) => {
    const x = (index % gridWidth) * (thumbSize + spacing);
    const y = Math.floor(index / gridWidth) * (thumbSize + spacing);

    return { input: imgBuffer, top: y, left: x };
  });

  const compositeTexts = validImages.map((imgBuffer, index) => {
    const x = (index % gridWidth) * (thumbSize + spacing);
    const y = Math.floor(index / gridWidth) * (thumbSize + spacing);

    const svgText = `<svg width="${thumbSize}" height="25">
    <text x="2%" y="50%" font-size="24" text-anchor="left" fill="white" dy=".3em">${index + 1}</text>
  </svg>`;
    const textBuffer = Buffer.from(svgText);

    return { input: textBuffer, top: y, left: x };
  });

  compositeImages.push(...compositeTexts);

  const fp = path.resolve("downloads", Date.now() + '.jpg');

  await sharp({
    create: {
      width: gridWidth * thumbSize + (gridWidth - 1) * spacing,
      height: rows * thumbSize + (rows - 1) * spacing,
      channels: 3,
      background: { r: 69, g: 69, b: 69 }
    }
  })
    .composite(compositeImages)
    .toFile(fp)
    .then(() => console.log('Thumbnail grid created as thumbnail_grid.jpg'))
    .catch((error) => console.error(`Error creating grid: ${error}`));

  return fp;
}

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start(async (ctx) => {
  ctx.replyWithMarkdownV2("***Welcome to Cobalt Fox\\!***\nCobalt Fox allows you to download videos from YouTube, Facebook, Instagram, Twitter, and many more platforms\\. Just send me a link to the video you want to download and I will take care of the rest\\.\n\nIf you want to know about additional options, type /help\\.");
});

bot.command("help", async (ctx) => {
  ctx.replyWithMarkdownV2("Just send me a link of the medium you want to download and I will take care of the rest\\. You can append some \"option flags\" if you want to customize the download\\. You don't have to specify flags, in that case I will decide what's best\\.\n\n***Option flags***\n*m\\=mute* \\- Mute the audio in the video\n*m\\=audio* \\- Only download the audio\n\n**Example:**\n`https://www.youtube.com/watch?v=dQw4w9WgXcQ m\\=audio`");
});

bot.command("supported", async (ctx) => {
  ctx.replyWithMarkdownV2("Here is a list of supported services:\n\n\\- Bilibili\n\\- Bluesky\n\\- Dailymotion\n\\- Instagram\n\\- Facebook\n\\- Loom\n\\- Ok\\.ru\n\\- Pinterest\n\\- Reddit\n\\- Rutube\n\\- Snapchat\n\\- Soundcloud\n\\- Streamable\n\\- Tiktok\n\\- Tumblr\n\\- Twitch clips\n\\- Twitter/x\n\\- Vimeo\n\\- Vine\n\\- vk videos & clips\n\\- Youtube\n\nNote: You can't download videos from Soundcloud and you can't download audio only from Facebook, loom, ok\\.ru, and vk\\.");
});

bot.command("credits", async (ctx) => {
  ctx.replyWithMarkdownV2("***Developed by @finnleyfox***\n\nCobalt Fox is powered by Cobalt\\. Cobalt is a free and open source project that allows you to download videos from various platforms\\. You can find the source code on [GitHub](https://github\\.com/imputnet/cobalt)\\.");
});

bot.on(message("text"), async (ctx) => {
  const text = ctx.message.text;
  const link = text.split(" ")[0];

  // do sanity check
  if (!link.startsWith("http")) {
    ctx.reply("Please provide a valid link");
    return;
  }

  ctx.reply("🔍 Resolving the URL...");

  // get the params
  let params = text.split(" ");

  // remove the link from the params
  // params are defined like this: m=audio
  // generate key value pairs and overwrite duplicates
  params = params.slice(1).reduce((acc, curr) => {
    const [key, value] = curr.split("=");
    acc[key] = value;
    return acc;
  }, {});

  const paramLookup = {
    "m": "downloadMode"
  };

  // check if the params are valid and replace the keys with the correct ones, delete invalid keys
  for (const key in params) {
    if (paramLookup[key] === undefined) {
      delete params[key];
    } else {
      params[paramLookup[key]] = params[key];
      delete params[key];
    }
  }

  let body = {
    ...params,
    filenameStyle: "basic",
    url: link,
  };

  const resCobalt = await axios.post("https://cobalt.finnley.dev", body, {
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "cobaltfox",
      "Authorization": "Api-Key " + process.env.COBALT_API_KEY,
    },
  }).catch((err) => {
    return err.response;
  });

  if (resCobalt.status !== 200) {
    switch (resCobalt.data.error.code) {
      case "error.api.fetch.empty":
        ctx.reply("❌ Cobalt was able to resolve the URL, but the response from the server was empty. I'm sorry.");
        break;
      default:    
        ctx.reply(`❌ Cobalt couldn't resolve the URL. Please make sure that the URL is supported.\n\nError Code: ${JSON.stringify(resCobalt.data.error.code)}`);
        break;
    }
    return;
  }

  const data = resCobalt.data;

  if (data.status === "error") {
    console.error(data);
    ctx.reply("❌ There was an error while processing the video. Please try again later.");
    return;
  }

  let fp;

  if (data.status === "tunnel" || data.status === "redirect") {

    try {
      ctx.reply("🔽 Download in progress...");

      if (!fs.existsSync("downloads")) fs.mkdirSync("downloads");

      fp = path.resolve("downloads", data.filename);

      const mediaStream = await axios.get(data.url, {
        responseType: "stream",
      });

      const fileSize = parseInt(mediaStream.headers['content-length'], 10);

      if (fileSize > 50 * 1024 * 1024) {
        ctx.reply("⚠ The file exceeds 50mb and cannot be downloaded. A link will be provided instead. Please note that the link will expire within a few minutes.");
        ctx.reply("✅ Resolve complete! Here is the download link: " + data.url);
        return;
      }

      const writer = fs.createWriteStream(fp);
      mediaStream.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      if (fs.statSync(fp).size > 50 * 1024 * 1024) {
        ctx.reply("⚠ The file is larger than 50mb and is being uploaded to zip.finnley.dev...");
        const form = new FormData();
        form.append('file', fs.readFileSync(fp), fp);

        const response = await axios.post(
          process.env.ZIP_INSTANCE + '/api/upload',
          form,
          {
            headers: {
              ...form.getHeaders(),
              'authorization': process.env.ZIP_TOKEN,
              'Content-Type': 'multipart/form-data',
              'Format': 'uuid',
              'No-JSON': 'true',
              'Original-Name': 'true',
              'Expires-At': '1h',
              'x-zipline-folder': 4
            }
          }
        );
        ctx.reply("✅ Download complete! Here is the download link: " + response.data + ".\nPlease note that the link will expire within one hour.");

      } else {
        ctx.reply("✅ Download complete! Sending...");

        if (data.type == "photo" || data.filename.endsWith(".jpg") || data.filename.endsWith(".png") || data.filename.endsWith(".jpeg") || data.filename.endsWith(".webp"))
          await ctx.replyWithPhoto({ source: fp });

        await ctx.replyWithDocument({ source: fp });
      }
    } catch (err) {
      if (err.response.error_code === 413) {
        ctx.reply("❌ The file exceeds 50mb and is too large to send due to Telegrams API restrictions. I'm sorry.");
      } else {
        ctx.reply("❌ There was an error while processing the link. Please try again later.");
        console.error(err);
      }
    } finally {
      try { fs.unlinkSync(fp); }
      catch { } // can't unlink if nothing exists kekw
    }
  }
  else if (data.status === "picker") {
    ctx.reply("❌ I was able to resolve the URL, but there are multiple choices. This isn't supported yet. Please try again later.");
    // FIXME: PLEASE IMPLEMENT THIS
    /*
    const previewPath = await processThumbnails(data);
    await ctx.replyWithPhoto({ source: previewPath }, { caption: "✅ Resolve complete! Please select the medium you want to download."});
    */
  }

});

// download the sticker and send it as a photo
bot.on(message("sticker"), async (ctx) => {
  await ctx.reply("🔍 Analysis...")
  let fp;

  try {
    const sticker = ctx.message.sticker;

    const stickerFileId = sticker.file_id;
    const stickerFile = await ctx.telegram.getFileLink(stickerFileId);
    const extension = stickerFile.href.split('.').pop();
    fp = path.resolve("downloads", stickerFileId + "." + extension);

    if (sticker.is_animated) {
      await ctx.reply("❌ Animated stickers are not supported.");
      return;
    }

    const mediaStream = await axios.get(stickerFile.href, {
      responseType: "stream",
    });

    const writer = fs.createWriteStream(fp);
    mediaStream.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    if (sticker.is_video) {
      await ctx.replyWithDocument({ source: fp });
    } else {
      const pngFp = path.resolve("downloads", stickerFileId + ".png");
      await sharp(fp).toFormat("png").toFile(pngFp);
      await ctx.replyWithDocument({ source: pngFp });
    }

  } catch (err) {
    ctx.reply("❌ There was an error while processing the sticker. Please try again later.");
    console.error(err);
  }

  try {
    fs.unlinkSync(fp);
    fs.unlinkSync(pngFp);
  }
  catch { } // can't unlink if nothing exists kekw
});

bot.launch();
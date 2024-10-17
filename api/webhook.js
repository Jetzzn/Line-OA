const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const QRCode = require('qrcode-svg');
const Airtable = require('airtable');
const sharp = require('sharp');

const app = express();
const upload = multer();

// ค่าคงที่ต่างๆ
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_LOGIN_CALLBACK_URL = process.env.LINE_LOGIN_CALLBACK_URL;
const JOTFORM_URL = process.env.JOTFORM_URL;
const LIFF_ID = process.env.LIFF_ID;
const SERVER_URL = process.env.SERVER_URL;

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const USER_TABLE_NAME = "Registrations";

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// LINE Webhook
app.post('/api/line-webhook', async (req, res) => {
  console.log("Received LINE webhook");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));

  const signature = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(req.rawBody)
    .digest("base64");

  if (signature !== req.headers["x-line-signature"]) {
    console.log("Invalid signature");
    return res.status(400).send("Invalid signature");
  }

  const events = req.body.events;
  console.log("Webhook events:", JSON.stringify(events, null, 2));

  for (const event of events) {
    try {
      if (event.type === "postback") {
        console.log("Received postback event:", JSON.stringify(event, null, 2));
        await handlePostback(event);
      } else if (event.type === "message" && event.message.type === "text") {
        console.log("Received message event:", JSON.stringify(event, null, 2));
        await handleMessage(event);
      } else {
        console.log("Received other type of event:", JSON.stringify(event, null, 2));
      }
    } catch (error) {
      console.error('Error processing event:', error);
    }
  }

  res.status(200).send("OK");
});

// JotForm Webhook
app.post('/api/jotform-webhook', upload.none(), async (req, res) => {
  console.log("Received JotForm webhook");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));

  let formData;
  try {
    formData = req.body.rawRequest ? JSON.parse(req.body.rawRequest) : req.body;
  } catch (error) {
    console.error("Error parsing form data:", error);
    formData = req.body;
  }

  console.log("Parsed form data:", JSON.stringify(formData, null, 2));

  const extractedFields = extractFormFields(formData);
  console.log("Extracted fields:", JSON.stringify(extractedFields, null, 2));

  const lineUserId = findLineUserId(extractedFields);
  console.log("Found LINE User ID:", lineUserId);

  if (lineUserId) {
    try {
      const message = composeConfirmationMessage(extractedFields);
      console.log("Composed message:", message);
      await sendLineNotificationWithQR(
        lineUserId,
        message,
        extractedFields.refId,
        extractedFields.firstName,
        extractedFields.lastName
      );
      console.log("Confirmation notification sent successfully");

      const registeredUserRichMenuId = await createRegisteredUserRichMenu();
      if (registeredUserRichMenuId) {
        await linkRichMenuToUser(lineUserId, registeredUserRichMenuId);
        console.log("Registered User Rich Menu linked successfully");
      }

      await saveUserDataToAirtable(extractedFields, lineUserId);

    } catch (error) {
      console.error(
        "Error in sending confirmation notification or updating rich menu:",
        error
      );
    }
  } else {
    console.log(
      "No LINE User ID found. Unable to send confirmation notification or update rich menu."
    );
  }

  res.status(200).json({ message: "Webhook processed" });
});

// ฟังก์ชันต่างๆ
async function handlePostback(event) {
  const { replyToken, postback, source } = event;
  const userId = source.userId;

  console.log(`Handling postback for user ${userId}: ${JSON.stringify(postback)}`);

  if (postback.data === "action=resend_qr") {
    console.log(`Attempting to resend QR code for user ${userId}`);
    await resendQRCode(userId);
  }
}

async function handleMessage(event) {
  const { replyToken, message, source, type } = event;

  if (type === "message" && message.type === "text") {
    if (message.text.toLowerCase() === "ลงทะเบียน") {
      const jotformUrlWithUserId = `${JOTFORM_URL}?lineUser=${source.userId}`;
      const replyMessage = `คุณสามารถลงทะเบียนได้ที่ลิงก์นี้:\n\n${jotformUrlWithUserId}`;
      await replyToUser(replyToken, replyMessage);
    } else {
      await replyToUser(
        replyToken,
        "ขอบคุณสำหรับข้อความ กรุณาใช้เมนูด้านล่างเพื่อดำเนินการต่าง ๆ"
      );
    }
  } else if (type === "postback") {
    const { data } = event.postback;
    if (data === "action=resend_qr") {
      await resendQRCode(source.userId);
    }
  }
}

async function saveUserDataToAirtable(userData, lineUserId) {
  return new Promise((resolve, reject) => {
    base(USER_TABLE_NAME).create([
      {
        fields: {
          "LINE User ID": lineUserId,
          "First Name": userData.firstName,
          "Last Name": userData.lastName,
          "Ref ID": userData.refId,
          "Timestamp": userData.timestamp,
        }
      }
    ], function(err, records) {
      if (err) {
        console.error(err);
        return reject(err);
      }
      console.log("User data saved to Airtable");
      resolve(records);
    });
  });
}

async function resendQRCode(userId) {
  console.log(`Starting resendQRCode for user: ${userId}`);
  try {
    const userInfo = await getUserInfoFromAirtable(userId, USER_TABLE_NAME);
    console.log(`User info retrieved:`, userInfo);

    if (userInfo && userInfo.refId) {
      const message = `นี่คือข้อมูลการลงทะเบียนของคุณ:
      
ชื่อ: ${userInfo.firstName} ${userInfo.lastName}
Ref ID: ${userInfo.refId}
เวลาที่ลงทะเบียน: ${userInfo.timestamp}

QR Code ของคุณอยู่ด้านล่างนี้`;

      const qrCodePath = path.join('/tmp', `qr_${userInfo.refId}.png`);
      
      try {
        await fs.access(qrCodePath);
        console.log(`Existing QR Code found at ${qrCodePath}, sending to user`);
        await sendLineNotificationWithExistingQR(userId, message, userInfo.refId);
      } catch (error) {
        console.log(`QR Code not found at ${qrCodePath}, generating a new one`);
        await sendLineNotificationWithQR(userId, message, userInfo.refId, userInfo.firstName, userInfo.lastName);
      }
    } else {
      console.error('User info or refId not found:', userInfo);
      await sendTextMessage(userId, "ขออภัย เราไม่พบข้อมูลการลงทะเบียนของคุณ กรุณาติดต่อเจ้าหน้าที่");
    }
  } catch (error) {
    console.error("Error in resendQRCode:", error);
    await sendTextMessage(userId, "เกิดข้อผิดพลาดในการส่ง QR Code กรุณาลองใหม่อีกครั้งในภายหลัง");
  }
  console.log(`Finished resendQRCode for user: ${userId}`);
}

async function getUserInfoFromAirtable(userId, tableName) {
  console.log(`Fetching user info from Airtable for userId: ${userId}`);
  return new Promise((resolve, reject) => {
    base(tableName)
      .select({
        filterByFormula: `{LINE User ID} = '${userId}'`
      })
      .firstPage((err, records) => {
        if (err) {
          console.error("Error fetching data from Airtable:", err);
          return reject(err);
        }
        if (records && records.length > 0) {
          const record = records[0];
          const userInfo = {
            firstName: record.get("First Name") || "",
            lastName: record.get("Last Name") || "",
            refId: record.get("Ref ID") || "",
            timestamp: record.get("Timestamp") || ""
          };
          console.log("Retrieved user info from Airtable:", userInfo);
          resolve(userInfo);
        } else {
          console.log("No user found with LINE User ID:", userId);
          resolve(null);
        }
      });
  });
}

function extractFormFields(formData) {
  const fields = {};

  function extractValue(obj) {
    if (typeof obj === "object" && obj !== null) {
      if ("answer" in obj) return obj.answer;
      if ("value" in obj) return obj.value;
      return JSON.stringify(obj);
    }
    return obj;
  }

  for (const [key, value] of Object.entries(formData)) {
    if (key.startsWith("q") && key.includes("_")) {
      const [, fieldName] = key.split("_");
      fields[fieldName] = extractValue(value);
    } else {
      fields[key] = extractValue(value);
    }
  }

  fields.timestamp = formData.created_at
    ? new Date(formData.created_at).toLocaleString("th-TH", {
        timeZone: "Asia/Bangkok",
      })
    : new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });

  fields.refId = fields.uniqueId || fields.uniqueId163 || fields.refId || "ไม่ระบุ";
  fields.firstName = fields.firstName || fields.name || "ไม่ระบุ";
  fields.lastName = fields.lastName || "ไม่ระบุ";

  return fields;
}

function findLineUserId(fields) {
  console.log("Searching for LINE User ID in fields:", JSON.stringify(fields, null, 2));

  function isValidLineUserId(id) {
    return typeof id === "string" && id.startsWith("U") && id.length === 33;
  }

  if (fields.lineUser && isValidLineUserId(fields.lineUser)) {
    console.log("Found valid LINE User ID in field: lineUser");
    return fields.lineUser;
  }

  for (const [key, value] of Object.entries(fields)) {
    if (isValidLineUserId(value)) {
      console.log(`Valid LINE User ID found in field: ${key}`);
      return value;
    }
  }

  console.log("No valid LINE User ID found in any field.");
  return null;
}

function composeConfirmationMessage(fields) {
  const firstName = fields.firstName || fields.name || "ไม่ระบุ";
  const lastName = fields.lastName || "ไม่ระบุ";
  const refId = fields.refId;
  const timestamp = fields.timestamp || "ไม่ระบุ";

  let message = "ขอบคุณสำหรับการลงทะเบียน! นี่คือข้อมูลการลงทะเบียนของคุณ:\n\n";
  message += `ชื่อ: ${firstName}\n`;
  message += `นามสกุล: ${lastName}\n`;
  message += `Ref ID: ${refId}\n`;
  message += `เวลาที่ลงทะเบียน: ${timestamp}\n`;
  message += "\nQR Code ของ Ref ID จะถูกส่งในข้อความถัดไป";

  return message;
}

async function generateQRCodeUrl(refId, firstName, lastName) {
  if (!refId || typeof refId !== 'string' || refId.trim() === '') {
    console.error('Invalid refId:', refId);
    throw new Error('Invalid or empty refId');
  }

  console.log(`Generating QR Code for: ${refId}, ${firstName}, ${lastName}`);

  try {
    const svgOutputPath = path.join('/tmp', `qr_${refId}.svg`);
    const pngOutputPath = path.join('/tmp', `qr_${refId}.png`);
    const bannerPath = path.join(__dirname, 'assets', 'banner.png');

    const bannerData = await fs.readFile(bannerPath);
    const bannerBase64 = bannerData.toString('base64');

    const bannerWidth = 800;
    const bannerHeight = 312;
    const qrSize = 400;
    const totalWidth = bannerWidth;
    const totalHeight = bannerHeight + qrSize + 130;

    const qr = new QRCode({
      content: refId,
      padding: 0,
      width: qrSize,
      height: qrSize,
      color: "#000000",
      background: "#FFFFFF",
      ecl: "H",
      join: true,
      xmlDeclaration: false,
      container: "svg-viewbox",
      pretty: true
    });

    const svgString = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}">
      <rect x="0" y="0" width="${totalWidth}" height="${totalHeight}" fill="#FFFFFF"/>
      <image href="data:image/png;base64,${bannerBase64}" x="0" y="0" width="${bannerWidth}" height="${bannerHeight}"/>
      <g transform="translate(${(totalWidth - qrSize) / 2}, ${bannerHeight + 25})">
        ${qr.svg().replace(/<\/?svg[^>]*>/g, '')}
      </g>
      <text x="${totalWidth / 2}" y="${totalHeight - 70}" text-anchor="middle" fill="#000000" font-family="Arial, sans-serif" font-size="20">OCSC EXPO 2024</text>
      <text x="${totalWidth / 2}" y="${totalHeight - 40}" text-anchor="middle" fill="#000000" font-family="Arial, sans-serif" font-size="16">Ref ID: ${refId}</text>
      <text x="${totalWidth / 2}" y="${totalHeight - 10}" text-anchor="middle" fill="#000000" font-family="Arial, sans-serif" font-size="16">${firstName} ${lastName}</text>
    </svg>`;

    await fs.writeFile(svgOutputPath, svgString);

    await sharp(Buffer.from(svgString))
      .png()
      .toFile(pngOutputPath);

    console.log(`QR code with large banner and name generated and converted successfully: ${pngOutputPath}`);
    return `/tmp/qr_${refId}.png`;
  } catch (error) {
    console.error('Error generating or converting QR code with large banner and name:', error);
    throw error;
  }
}

async function sendLineNotificationWithQR(userId, message, refId, firstName, lastName) {
  console.log(`Sending LINE notification with QR to user: ${userId}`);
  if (!userId || !message || !refId) {
    console.error('Missing required parameters:', { userId, message, refId, firstName, lastName });
    throw new Error('Missing required parameters for sending LINE notification');
  }

  const LINE_API_ENDPOINT = 'https://api.line.me/v2/bot/message/push';
  
  try {
    const qrCodeUrl = await generateQRCodeUrl(refId, firstName, lastName);
    const fullQrCodeUrl = `${SERVER_URL}${qrCodeUrl}`;
    
    console.log('QR Code URL:', fullQrCodeUrl);

    const lineResponse = await axios.post(LINE_API_ENDPOINT, {
      to: userId,
      messages: [
        { type: 'text', text: message },
        { 
          type: 'image', 
          originalContentUrl: fullQrCodeUrl,
          previewImageUrl: fullQrCodeUrl
        }
      ]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      }
    });
    
    console.log('LINE API Response:', lineResponse.data);
  } catch (error) {
    console.error('Error sending LINE notification with QR:', error.message);
    await sendTextMessage(userId, `${message}\n\nRef ID: ${refId}\nName: ${firstName} ${lastName}`);
  }
}

async function sendTextMessage(userId, message) {
  const LINE_API_ENDPOINT = "https://api.line.me/v2/bot/message/push";

  try {
    await axios.post(
      LINE_API_ENDPOINT,
      {
        to: userId,
        messages: [{ type: "text", text: message }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        },
      }
    );
    console.log("Fallback text message sent successfully");
  } catch (error) {
    console.error("Error sending fallback text message:", error);
  }
}

async function createRegisteredUserRichMenu() {
  const richMenuObject = {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: "Registered User Menu",
    chatBarText: "เมนู",
    areas: [
      {
        bounds: { x: 0, y: 0, width: 833, height: 843 },
        action: { type: "uri", uri: "https://www.ocscexpo.org/" },
      },
      {
        bounds: { x: 833, y: 0, width: 834, height: 843 },
        action: {
          type: "uri",
          uri: "https://www.ocscexpo.org/institution-lists-2024",
        },
      },
      {
        bounds: { x: 1667, y: 0, width: 833, height: 843 },
        action: {
          type: "uri",
          uri: "https://www.ocscexpo.org/visitors/event-agenda-2024",
        },
      },
      {
        bounds: { x: 0, y: 843, width: 1250, height: 843 },
        action: { type: "postback", data: "action=resend_qr" },
      },
      {
        bounds: { x: 1250, y: 843, width: 1250, height: 843 },
        action: { type: "uri", uri: "https://www.ocscexpo.org/contact-us" },
      },
    ],
  };

  try {
    const createResponse = await axios.post(
      "https://api.line.me/v2/bot/richmenu",
      richMenuObject,
      {
        headers: {
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    const richMenuId = createResponse.data.richMenuId;
    console.log("Registered User Rich Menu created:", richMenuId);

    const imagePath = path.join(__dirname, 'assets', '2024 Line Rich Menu-02.jpg');
    await uploadRichMenuImage(richMenuId, imagePath);

    console.log("Registered User Rich Menu setup completed successfully");
    return richMenuId;
  } catch (error) {
    console.error("Error creating Registered User Rich Menu:", error);
    return null;
  }
}

async function uploadRichMenuImage(richMenuId, imagePath) {
  try {
    const image = await fs.readFile(imagePath);
    const uploadResponse = await axios.post(
      `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`,
      image,
      {
        headers: {
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "image/jpeg",
        },
      }
    );

    console.log(
      "Image upload response:",
      uploadResponse.status,
      uploadResponse.statusText
    );

    if (uploadResponse.status === 200) {
      console.log("Rich Menu image uploaded successfully");
    } else {
      console.error(
        "Unexpected status code when uploading image:",
        uploadResponse.status
      );
    }
  } catch (error) {
    console.error(
      "Error uploading Rich Menu image:",
      error.response ? error.response.data : error.message
    );
  }
}

async function linkRichMenuToUser(userId, richMenuId) {
  console.log(`Linking Rich Menu ${richMenuId} to user ${userId}`);
  try {
    const response = await axios.post(
      `https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`,
      {},
      { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    console.log(`Rich Menu linked to user ${userId} successfully:`, response.data);
  } catch (error) {
    console.error(
      "Error linking Rich Menu to user:",
      error.response ? error.response.data : error.message
    );
  }
}

// เพิ่มเส้นทางทดสอบ
app.get("/api/test", (req, res) => {
  res.status(200).json({ message: "Server is running correctly" });
});

app.get("/api/test-resend-qr/:userId", async (req, res) => {
  const userId = req.params.userId;
  console.log(`Testing resend QR for user: ${userId}`);
  try {
    await resendQRCode(userId);
    res.status(200).send("QR Code resend test initiated. Check server logs for details.");
  } catch (error) {
    console.error("Error in test-resend-qr:", error);
    res.status(500).send("Error occurred during QR Code resend test.");
  }
});

module.exports = serverless(app);
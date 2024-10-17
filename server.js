const express = require('serverless-express/express');
const serverless = require('serverless-express/serverless');
const axios = require("axios");
const crypto = require("crypto");
const AWS = require('aws-sdk');
const sharp = require('sharp');
const QRCode = require('qrcode-svg');

const app = express();

// Environment variables
const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_LOGIN_CALLBACK_URL = process.env.LINE_LOGIN_CALLBACK_URL;
const JOTFORM_URL = process.env.JOTFORM_URL;
const LIFF_ID = process.env.LIFF_ID;
const SERVER_URL = process.env.SERVER_URL;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;

// Initialize AWS services
const s3 = new AWS.S3();
const dynamodb = new AWS.DynamoDB.DocumentClient();

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  },
}));

// Webhook endpoint
app.post("/line-webhook", async (req, res) => {
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
  }
}

async function resendQRCode(userId) {
  console.log(`Starting resendQRCode for user: ${userId}`);
  try {
    const userInfo = await getUserInfoFromDynamoDB(userId);
    console.log(`User info retrieved:`, userInfo);

    if (userInfo && userInfo.refId) {
      const message = `นี่คือข้อมูลการลงทะเบียนของคุณ:
      
ชื่อ: ${userInfo.firstName} ${userInfo.lastName}
Ref ID: ${userInfo.refId}
เวลาที่ลงทะเบียน: ${userInfo.timestamp}

QR Code ของคุณอยู่ด้านล่างนี้`;

      const qrCodeKey = `qr_${userInfo.refId}.png`;
      
      try {
        await s3.headObject({ Bucket: S3_BUCKET_NAME, Key: qrCodeKey }).promise();
        console.log(`Existing QR Code found in S3, sending to user`);
        await sendLineNotificationWithExistingQR(userId, message, userInfo.refId);
      } catch (error) {
        if (error.code === 'NotFound') {
          console.log(`QR Code not found in S3, generating a new one`);
          await sendLineNotificationWithQR(userId, message, userInfo.refId, userInfo.firstName, userInfo.lastName);
        } else {
          throw error;
        }
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

async function getUserInfoFromDynamoDB(userId) {
  const params = {
    TableName: "UserRegistrations",
    Key: {
      "userId": userId
    }
  };

  try {
    const data = await dynamodb.get(params).promise();
    return data.Item;
  } catch (error) {
    console.error("Error fetching user info from DynamoDB:", error);
    throw error;
  }
}

async function generateQRCodeUrl(refId, firstName, lastName) {
  if (!refId || typeof refId !== 'string' || refId.trim() === '') {
    console.error('Invalid refId:', refId);
    throw new Error('Invalid or empty refId');
  }

  console.log(`Generating QR Code for: ${refId}, ${firstName}, ${lastName}`);

  try {
    const qr = new QRCode({
      content: refId,
      padding: 0,
      width: 400,
      height: 400,
      color: "#000000",
      background: "#FFFFFF",
      ecl: "H"
    });

    const svgString = `
    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="842">
      <rect x="0" y="0" width="800" height="842" fill="#FFFFFF"/>
      <image href="${SERVER_URL}/banner.png" x="0" y="0" width="800" height="312"/>
      <g transform="translate(200, 337)">
        ${qr.svg().replace(/<\/?svg[^>]*>/g, '')}
      </g>
      <text x="400" y="772" text-anchor="middle" fill="#000000" font-family="Arial, sans-serif" font-size="20">OCSC EXPO 2024</text>
      <text x="400" y="802" text-anchor="middle" fill="#000000" font-family="Arial, sans-serif" font-size="16">Ref ID: ${refId}</text>
      <text x="400" y="832" text-anchor="middle" fill="#000000" font-family="Arial, sans-serif" font-size="16">${firstName} ${lastName}</text>
    </svg>`;

    const pngBuffer = await sharp(Buffer.from(svgString))
      .png()
      .toBuffer();

    const s3Params = {
      Bucket: S3_BUCKET_NAME,
      Key: `qr_${refId}.png`,
      Body: pngBuffer,
      ContentType: 'image/png'
    };

    await s3.putObject(s3Params).promise();

    console.log(`QR code generated and uploaded successfully: qr_${refId}.png`);
    return `${SERVER_URL}/qr_${refId}.png`;
  } catch (error) {
    console.error('Error generating or uploading QR code:', error);
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
    
    console.log('QR Code URL:', qrCodeUrl);

    const lineResponse = await axios.post(LINE_API_ENDPOINT, {
      to: userId,
      messages: [
        { type: 'text', text: message },
        { 
          type: 'image', 
          originalContentUrl: qrCodeUrl,
          previewImageUrl: qrCodeUrl
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

async function sendLineNotificationWithExistingQR(userId, message, refId) {
  const LINE_API_ENDPOINT = 'https://api.line.me/v2/bot/message/push';
  const qrCodeUrl = `${SERVER_URL}/qr_${refId}.png`;
  
  try {
    const lineResponse = await axios.post(LINE_API_ENDPOINT, {
      to: userId,
      messages: [
        { type: 'text', text: message },
        { 
          type: 'image', 
          originalContentUrl: qrCodeUrl,
          previewImageUrl: qrCodeUrl
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
    console.error('Error sending LINE notification with existing QR:', error.message);
    await sendTextMessage(userId, `${message}\n\nขออภัย เกิดข้อผิดพลาดในการส่งรูปภาพ QR Code`);
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
    console.log("Text message sent successfully");
  } catch (error) {
    console.error("Error sending text message:", error);
  }
}

async function replyToUser(replyToken, message) {
  const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";

  try {
    const response = await axios.post(
      LINE_REPLY_ENDPOINT,
      {
        replyToken: replyToken,
        messages: [{ type: "text", text: message }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        },
      }
    );
    console.log("LINE API response:", response.data);
  } catch (error) {
    console.error(
      "Error replying to LINE message:",
      error.response ? error.response.data : error.message
    );
  }
}

// Use serverless-express
exports.handler = serverless(app);
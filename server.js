const express = require("express");
const axios = require("axios");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const QRCode = require('qrcode-svg');
const upload = multer();
const Airtable = require("airtable");
const app = express();
const sharp = require('sharp');
const port = process.env.PORT || 3000;

const LINE_CHANNEL_ID = "2006446401";
const LINE_CHANNEL_SECRET = "f48a52166e606cec7c5ba80343f550e3";
const LINE_CHANNEL_ACCESS_TOKEN =
  "zQGgL8shLqeb59tVUB4FBLD64Cc9oGvpaa2E3ejO2A+g/LyeDgGfJeHo5plpmVzQP0UjuJ2j76fXcsjMHYjPUyfy5yuJVNYGj5mxqaKXm2VdPGz9MkvdymEytB1OzsEuxEFDtzxbrTpsZZhIX9w+ygdB04t89/1O/w1cDnyilFU=";
const LINE_LOGIN_CALLBACK_URL =
  "https://6e89-223-206-45-24.ngrok-free.app/line-login-callback";
const JOTFORM_URL = "https://form.jotform.com/242799562521465";
const LIFF_ID = "2006446401-VnbJ5dG9";
const SERVER_URL =
  process.env.SERVER_URL || "https://6e89-223-206-45-24.ngrok-free.app";
const base = new Airtable({
  apiKey:
    "patyaq8VgFKmFxImg.52df4cd8f38ef9bdb57b2189c48f1a8950bafe14552f4d720c84271786c2b4ee",
}).base("appVADkxTuwcN78c6");
const USER_TABLE_NAME = "Registrations";
app.use(express.static(path.join(__dirname, "public")));
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/line-login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const lineLoginUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${LINE_CHANNEL_ID}&redirect_uri=${encodeURIComponent(
    LINE_LOGIN_CALLBACK_URL
  )}&state=${state}&scope=profile%20openid`;
  res.redirect(lineLoginUrl);
});

app.get("/line-login-callback", async (req, res) => {
  const { code, state } = req.query;

  try {
    const tokenResponse = await axios.post(
      "https://api.line.me/oauth2/v2.1/token",
      {
        grant_type: "authorization_code",
        code: code,
        redirect_uri: LINE_LOGIN_CALLBACK_URL,
        client_id: LINE_CHANNEL_ID,
        client_secret: LINE_CHANNEL_SECRET,
      },
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const accessToken = tokenResponse.data.access_token;
    const profileResponse = await axios.get("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const userProfile = profileResponse.data;
    const jotformUrlWithUserId = `${JOTFORM_URL}?lineUser=${userProfile.userId}`;
    res.redirect(jotformUrlWithUserId);
  } catch (error) {
    console.error("Error in LINE Login callback:", error);
    res.status(500).send("Error processing LINE Login");
  }
});

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
      if (event.type === "postback" && event.postback.data === "action=resend_qr") {
        const userId = event.source.userId;
        console.log("Received resend_qr action for user:", userId);
        await resendQRCode(userId);
      } else if (event.type === "message" && event.message.type === "text") {
        await handleMessage(event);
      }
    } catch (error) {
      console.error('Error processing event:', error);
      const userId = event.source.userId;
      await sendTextMessage(userId, "เกิดข้อผิดพลาดในการดำเนินการ กรุณาลองใหม่อีกครั้งในภายหลัง");
    }
  }

  res.status(200).send("OK");
});

app.post("/jotform-webhook", upload.none(), async (req, res) => {
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

      // Create and link the new rich menu for registered users
      const registeredUserRichMenuId = await createRegisteredUserRichMenu();
      if (registeredUserRichMenuId) {
        await linkRichMenuToUser(lineUserId, registeredUserRichMenuId);
        console.log("Registered User Rich Menu linked successfully");
      }

      // Save user data to Airtable instead of userDataStorage
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
          // Add any other fields you want to save
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
  try {
    const userInfo = await getUserInfoFromAirtable(userId, USER_TABLE_NAME);

    if (userInfo && userInfo.refId) {
      const message = `นี่คือข้อมูลการลงทะเบียนของคุณ:
      
ชื่อ: ${userInfo.firstName} ${userInfo.lastName}
Ref ID: ${userInfo.refId}
เวลาที่ลงทะเบียน: ${userInfo.timestamp}

QR Code ของคุณอยู่ด้านล่างนี้`;

      const qrCodePath = path.join(__dirname, 'public', `qr_${userInfo.refId}.png`);
      
      // ตรวจสอบว่า QR Code มีอยู่แล้วหรือไม่
      try {
        await fs.access(qrCodePath);
        // ถ้า QR Code มีอยู่แล้ว ให้ส่งกลับไปที่ผู้ใช้
        await sendLineNotificationWithExistingQR(userId, message, userInfo.refId);
      } catch (error) {
        // ถ้า QR Code ไม่มีอยู่ ให้สร้างใหม่
        console.log("QR Code not found, generating a new one");
        await sendLineNotificationWithQR(userId, message, userInfo.refId, userInfo.firstName, userInfo.lastName);
      }
    } else {
      console.error('User info or refId not found:', userInfo);
      await sendTextMessage(userId, "ขออภัย เราไม่พบข้อมูลการลงทะเบียนของคุณ กรุณาติดต่อเจ้าหน้าที่");
    }
  } catch (error) {
    console.error("Error resending QR Code:", error);
    await sendTextMessage(userId, "เกิดข้อผิดพลาดในการส่ง QR Code กรุณาลองใหม่อีกครั้งในภายหลัง");
  }
}async function sendLineNotificationWithExistingQR(userId, message, refId) {
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
// async function handlePostback(event) {
//   const { replyToken, postback, source } = event;
//   const userId = source.userId;

//   if (postback.data === "action=resend_qr") {
//     try {
//       // Retrieve user data from memory or a fast database instead of Airtable
//       const userData = await getUserDataFromFastStorage(userId);
//       if (userData) {
//         const message = `นี่คือข้อมูลการลงทะเบียนของคุณ:
        
// ชื่อ: ${userData.firstName} ${userData.lastName}
// Ref ID: ${userData.refId}
// เวลาที่ลงทะเบียน: ${userData.timestamp}

// QR Code ของคุณอยู่ด้านล่างนี้`;

//         await sendLineNotificationWithQR(userId, message, userData.refId, userData.firstName, userData.lastName);
//       } else {
//         await sendTextMessage(userId, "ขออภัย เราไม่สามารถดึงข้อมูลของคุณได้ กรุณาติดต่อเจ้าหน้าที่");
//       }
//     } catch (error) {
//       console.error("Error resending QR code:", error);
//       await sendTextMessage(userId, "เกิดข้อผิดพลาดในการส่ง QR Code กรุณาลองใหม่อีกครั้งในภายหลัง");
//     }
//   }
// }
// const userDataStorage = {};

// async function getUserDataFromFastStorage(userId) {
//   // In a real application, this would be a database query or cache lookup
//   return userDataStorage[userId];
// }
// async function handleNewFriend(userId) {
//   const welcomeMessage = `ยินดีต้อนรับ!\n• กดที่เมนูด้านล่างเพื่อไปยังฟอร์มลงทะเบียน`;
//   await sendLineNotification(userId, welcomeMessage);

//   const richMenuId = await createRichMenu();
//   if (richMenuId) {
//     await linkRichMenuToUser(userId, richMenuId);
//   }
// }

async function handleMessage(event) {
  const { replyToken, message, source } = event;

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

  if (event.type === "postback" && event.postback.data === "action=resend_qr") {
    const userId = event.source.userId;

    try {
      const userInfo = await getUserInfoFromAirtable(userId, USER_TABLE_NAME);

      if (userInfo) {
        const message = `นี่คือข้อมูลการลงทะเบียนของคุณ:
        
ชื่อ: ${userInfo.firstName} ${userInfo.lastName}
Ref ID: ${userInfo.refId}
 เวลาที่ลงทะเบียน: ${userInfo.timestamp}

QR Code ของคุณอยู่ด้านล่างนี้`;

        await sendLineNotificationWithQR(userId, message,userInfo.refId); 
      } else {
        await sendTextMessage(
          userId,
          "ขออภัย เราไม่สามารถดึงข้อมูลของคุณได้ กรุณาติดต่อเจ้าหน้าที่"
        );
      }
    } catch (error) {
      console.error("Error retrieving user info from Airtable:", error);
      await sendTextMessage(
        userId,
        "เกิดข้อผิดพลาดในการดึงข้อมูล กรุณาลองใหม่อีกครั้งในภายหลัง"
      );
    }
  }
}

async function createRichMenu() {
  const richMenuObject = {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: "Three Menu Layout",
    chatBarText: "เมนู",
    areas: [
      {
        bounds: { x: 0, y: 0, width: 1666, height: 1686 },
        action: { type: "uri", uri: `https://liff.line.me/${LIFF_ID}` },
      },
      {
        bounds: { x: 1666, y: 0, width: 834, height: 843 },
        action: { type: "uri", uri: "https://www.ocscexpo.org/" },
      },
      {
        bounds: { x: 1666, y: 843, width: 834, height: 843 },
        action: {
          type: "uri",
          uri: "https://www.ocscexpo.org/institution-lists-2024",
        },
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

    console.log("Using LIFF ID:", LIFF_ID);
    const richMenuId = createResponse.data.richMenuId;
    console.log("Rich Menu created:", richMenuId);

    const imagePath = "./2024 Line Rich Menu-01.jpg";
    await uploadRichMenuImage(richMenuId, imagePath);
    await setDefaultRichMenu(richMenuId);

    console.log("Rich Menu setup completed successfully");
    return richMenuId;
  } catch (error) {
    console.error("Error creating Rich Menu:", error);
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

async function setDefaultRichMenu(richMenuId) {
  try {
    const response = await axios.post(
      `https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`,
      {},
      {
        headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      }
    );
    console.log(
      "Set default Rich Menu response:",
      response.status,
      response.statusText
    );
    if (response.status === 200) {
      console.log("Rich Menu set as default successfully");
    } else {
      console.error(
        "Unexpected status code when setting default Rich Menu:",
        response.status
      );
    }
  } catch (error) {
    console.error(
      "Error setting default Rich Menu:",
      error.response ? error.response.data : error.message
    );
  }
}

async function linkRichMenuToUser(userId, richMenuId) {
  try {
    await axios.post(
      `https://api.line.me/v2/bot/user/${userId}/richmenu/${richMenuId}`,
      {},
      { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } }
    );
    console.log(`Rich Menu linked to user ${userId} successfully`);
  } catch (error) {
    console.error(
      "Error linking Rich Menu to user:",
      error.response ? error.response.data : error.message
    );
  }
}
async function createRegisteredUserRichMenu() {
  const richMenuObject = {
    size: { width: 2500, height: 1686 },
    selected: true,
    name: "Registered User Menu",
    chatBarText: "เมนู",
    areas: [
      // Top row: 3 menus
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
      // Bottom row: 2 menus
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

    const imagePath = "./2024 Line Rich Menu-02.jpg";
    await uploadRichMenuImage(richMenuId, imagePath);

    console.log("Registered User Rich Menu setup completed successfully");
    return richMenuId;
  } catch (error) {
    console.error("Error creating Registered User Rich Menu:", error);
    return null;
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

  fields.refId =
    fields.uniqueId || fields.uniqueId163 || fields.refId || "ไม่ระบุ";
  
  // Ensure firstName and lastName are set
  fields.firstName = fields.firstName || fields.name || "ไม่ระบุ";
  fields.lastName = fields.lastName || "ไม่ระบุ";

  return fields;
}


function findLineUserId(fields) {
  console.log(
    "Searching for LINE User ID in fields:",
    JSON.stringify(fields, null, 2)
  );

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
    const svgOutputPath = path.join(__dirname, 'public', `qr_${refId}.svg`);
    const pngOutputPath = path.join(__dirname, 'public', `qr_${refId}.png`);
    const bannerPath = path.join(__dirname, 'assets', 'banner.png');

    // อ่านไฟล์แบนเนอร์และแปลงเป็น Base64
    const bannerData = await fs.readFile(bannerPath);
    const bannerBase64 = bannerData.toString('base64');

    // กำหนดขนาดใหม่
    const bannerWidth = 800;
    const bannerHeight = 312;
    const qrSize = 400; // ขนาดของ QR code
    const totalWidth = bannerWidth;
    const totalHeight = bannerHeight + qrSize + 130; // เพิ่มพื้นที่สำหรับข้อความเพิ่มเติม

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

    // สร้าง SVG string ที่สมบูรณ์
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

    // บันทึก SVG ไฟล์
    await fs.writeFile(svgOutputPath, svgString);

    // แปลง SVG เป็น PNG
    await sharp(Buffer.from(svgString))
      .png()
      .toFile(pngOutputPath);

    console.log(`QR code with large banner and name generated and converted successfully: ${pngOutputPath}`);
    return `/qr_${refId}.png`;
  } catch (error) {
    console.error('Error generating or converting QR code with large banner and name:', error);
    throw error;
  }
}

module.exports = { generateQRCodeUrl };
async function sendLineNotificationWithQR(userId, message, refId, firstName, lastName) {
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
    // ส่งข้อความแทนหากการส่งรูปภาพล้มเหลว
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

async function deleteAllRichMenus() {
  try {
    const listResponse = await axios.get(
      "https://api.line.me/v2/bot/richmenu/list",
      {
        headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      }
    );

    const richMenus = listResponse.data.richmenus;

    for (const menu of richMenus) {
      await axios.delete(
        `https://api.line.me/v2/bot/richmenu/${menu.richMenuId}`,
        {
          headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
        }
      );
      console.log(`Deleted rich menu: ${menu.richMenuId}`);
    }

    console.log("All existing rich menus have been deleted.");
  } catch (error) {
    console.error(
      "Error deleting rich menus:",
      error.response ? error.response.data : error.message
    );
  }
}
async function getUserInfoFromAirtable(userId, tableName) {
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

async function resendQRCode(userId) {
  try {
    console.log("Attempting to resend QR Code for user:", userId);
    const userInfo = await getUserInfoFromAirtable(userId, USER_TABLE_NAME);

    if (userInfo && userInfo.refId) {
      console.log("User info found:", userInfo);
      const message = `นี่คือข้อมูลการลงทะเบียนของคุณ:
      
ชื่อ: ${userInfo.firstName} ${userInfo.lastName}
Ref ID: ${userInfo.refId}
เวลาที่ลงทะเบียน: ${userInfo.timestamp}

QR Code ของคุณอยู่ด้านล่างนี้`;

      const qrCodePath = path.join(__dirname, 'public', `qr_${userInfo.refId}.png`);
      
      try {
        await fs.access(qrCodePath);
        console.log("Existing QR Code found, sending to user");
        await sendLineNotificationWithExistingQR(userId, message, userInfo.refId);
      } catch (error) {
        console.log("QR Code not found, generating a new one");
        await sendLineNotificationWithQR(userId, message, userInfo.refId, userInfo.firstName, userInfo.lastName);
      }
    } else {
      console.error('User info or refId not found:', userInfo);
      await sendTextMessage(userId, "ขออภัย เราไม่พบข้อมูลการลงทะเบียนของคุณ กรุณาติดต่อเจ้าหน้าที่");
    }
  } catch (error) {
    console.error("Error resending QR Code:", error);
    await sendTextMessage(userId, "เกิดข้อผิดพลาดในการส่ง QR Code กรุณาลองใหม่อีกครั้งในภายหลัง");
  }
}
module.exports = { getUserInfoFromAirtable };
app.get("/test", (req, res) => {
  res.status(200).json({ message: "Server is running correctly" });
});

app.listen(port, async () => {
  console.log(`Server running on port ${port}`);
  try {
    // Delete all existing rich menus
    await deleteAllRichMenus();

    // Create a new rich menu
    const richMenuId = await createRichMenu();
    if (richMenuId) {
      console.log(
        "New Rich Menu created and set successfully with ID:",
        richMenuId
      );
    } else {
      console.error("Failed to create new Rich Menu");
    }
  } catch (error) {
    console.error("Error setting up Rich Menu:", error);
  }
});

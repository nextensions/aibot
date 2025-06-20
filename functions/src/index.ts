import { onRequest, onCall } from "firebase-functions/v2/https";
import {
  onDocumentCreated,
  onDocumentUpdated,
} from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { messagingApi, validateSignature } from "@line/bot-sdk";
import { google } from "googleapis";
import * as dotenv from "dotenv";

dotenv.config();
admin.initializeApp();

export const helloWorld = onRequest((request, response) => {
  logger.info("Hello World function called", { structuredData: true });
  response.json({
    message: "Hello from Firebase! test push",
    timestamp: new Date().toISOString(),
    method: request.method,
  });
});

export const getUserData = onCall(async (request) => {
  const { userId } = request.data;

  if (!userId) {
    throw new Error("userId is required");
  }

  try {
    const userDoc = await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .get();

    if (!userDoc.exists) {
      throw new Error("User not found");
    }

    logger.info("User data retrieved", { userId });
    return {
      success: true,
      data: userDoc.data(),
    };
  } catch (error) {
    logger.error("Error getting user data", { userId, error });
    throw error;
  }
});

export const createUser = onCall(async (request) => {
  const { email, name } = request.data;

  if (!email || !name) {
    throw new Error("Email and name are required");
  }

  try {
    const userRef = admin.firestore().collection("users").doc();
    const userData = {
      email,
      name,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await userRef.set(userData);

    logger.info("User created", { userId: userRef.id, email });
    return {
      success: true,
      userId: userRef.id,
      message: "User created successfully",
    };
  } catch (error) {
    logger.error("Error creating user", { email, error });
    throw error;
  }
});

export const onUserCreated = onDocumentCreated("users/{userId}", (event) => {
  const userId = event.params.userId;
  const userData = event.data?.data();

  logger.info("New user created trigger", { userId, userData });

  return admin
    .firestore()
    .collection("notifications")
    .add({
      type: "user_created",
      userId,
      message: `Welcome ${userData?.name}!`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
});

export const onUserUpdated = onDocumentUpdated("users/{userId}", (event) => {
  const userId = event.params.userId;
  const beforeData = event.data?.before.data();
  const afterData = event.data?.after.data();

  logger.info("User updated trigger", { userId, beforeData, afterData });

  return admin
    .firestore()
    .collection("audit_logs")
    .add({
      type: "user_updated",
      userId,
      changes: {
        before: beforeData,
        after: afterData,
      },
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
});

export const dailyCleanup = onSchedule("0 2 * * *", async () => {
  logger.info("Daily cleanup job started");

  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);

    const oldLogsQuery = admin
      .firestore()
      .collection("audit_logs")
      .where("timestamp", "<", cutoffDate);

    const snapshot = await oldLogsQuery.get();
    const batch = admin.firestore().batch();

    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();

    logger.info("Daily cleanup completed", { deletedLogs: snapshot.size });
  } catch (error) {
    logger.error("Daily cleanup failed", { error });
    throw error;
  }
});

export const sendNotification = onCall(async (request) => {
  const { userId, title, body } = request.data;

  if (!userId || !title || !body) {
    throw new Error("userId, title, and body are required");
  }

  try {
    const userDoc = await admin
      .firestore()
      .collection("users")
      .doc(userId)
      .get();

    if (!userDoc.exists) {
      throw new Error("User not found");
    }

    const userData = userDoc.data();
    const fcmToken = userData?.fcmToken;

    if (!fcmToken) {
      throw new Error("User has no FCM token");
    }

    const message = {
      notification: {
        title,
        body,
      },
      token: fcmToken,
    };

    const response = await admin.messaging().send(message);

    await admin.firestore().collection("notifications").add({
      userId,
      title,
      body,
      messageId: response,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info("Notification sent", { userId, messageId: response });
    return { success: true, messageId: response };
  } catch (error) {
    logger.error("Error sending notification", { userId, error });
    throw error;
  }
});

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const GOOGLE_SERVICE_ACCOUNT_EMAIL =
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY || "";

interface LineMessage {
  timestamp: number;
  userId: string;
  displayName: string;
  messageId: string;
  message: string;
  messageType: string;
}

/**
 * Appends LINE message data to Google Sheets
 * @param {LineMessage} data - The LINE message data to append
 * @return {Promise<void>}
 */
async function appendToGoogleSheet(data: LineMessage): Promise<void> {
  try {
    const auth = new google.auth.JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    const values = [
      [
        new Date(data.timestamp).toISOString(),
        data.userId,
        data.displayName,
        data.messageId,
        data.message,
        data.messageType,
      ],
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Sheet1!A:F",
      valueInputOption: "RAW",
      requestBody: {
        values,
      },
    });

    logger.info("Data appended to Google Sheet", { messageId: data.messageId });
  } catch (error) {
    logger.error("Error appending to Google Sheet", { error });
    throw error;
  }
}

/**
 * Gets the display name of a LINE user
 * @param {string} userId - The LINE user ID
 * @return {Promise<string>} The user's display name
 */
async function getUserDisplayName(userId: string): Promise<string> {
  try {
    const lineClient = new messagingApi.MessagingApiClient({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
    });

    const profile = await lineClient.getProfile(userId);
    return profile.displayName;
  } catch (error) {
    logger.error("Error getting user profile", { userId, error });
    return "Unknown User";
  }
}

export const lineWebhook = onRequest(async (request, response) => {
  try {
    const signature = request.headers["x-line-signature"] as string;
    const body = JSON.stringify(request.body);

    if (!validateSignature(body, LINE_CHANNEL_SECRET, signature)) {
      logger.error("Invalid LINE signature");
      response.status(401).send("Unauthorized");
      return;
    }

    const events = request.body.events;

    for (const event of events) {
      if (event.type === "message") {
        const userId = event.source.userId;
        const messageId = event.message.id;
        const timestamp = event.timestamp;

        let message = "";
        const messageType = event.message.type;

        switch (event.message.type) {
          case "text":
            message = event.message.text;
            break;
          case "image":
            message = "Image sent";
            break;
          case "video":
            message = "Video sent";
            break;
          case "audio":
            message = "Audio sent";
            break;
          case "file":
            message = `File sent: ${event.message.fileName || "Unknown"}`;
            break;
          case "location":
            message = `Location: ${event.message.address}`;
            break;
          case "sticker":
            message = `Sticker: ${event.message.stickerId}`;
            break;
          default:
            message = "Unsupported message type";
        }

        const displayName = await getUserDisplayName(userId);

        const lineMessage: LineMessage = {
          timestamp,
          userId,
          displayName,
          messageId,
          message,
          messageType,
        };

        await appendToGoogleSheet(lineMessage);

        // logger.info("LINE message processed", {
        //   userId,
        //   messageId,
        //   messageType,
        //   displayName,
        // });
      }
    }

    response.status(200).send("OK");
  } catch (error) {
    logger.error("Error processing LINE webhook", { error });
    response.status(500).send("Internal Server Error");
  }
});

export const setupGoogleSheetHeaders = onCall(async () => {
  try {
    const auth = new google.auth.JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    const headers = [
      [
        "Timestamp",
        "User ID",
        "Display Name",
        "Message ID",
        "Message",
        "Message Type",
      ],
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Sheet1!A1:F1",
      valueInputOption: "RAW",
      requestBody: {
        values: headers,
      },
    });

    logger.info("Google Sheet headers set up successfully");
    return { success: true, message: "Headers set up successfully" };
  } catch (error) {
    logger.error("Error setting up Google Sheet headers", { error });
    throw error;
  }
});

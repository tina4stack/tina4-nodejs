import { BaseModel } from "../../baseModel.js";

/**
 * Attachment - a file linked to a channel (and optionally a message).
 * channel_id scopes the file for permission checks; message_id is null until
 * the file is attached to a posted message. storage_key is the StorageBackend
 * key; the row carries only metadata, never the blob.
 */
export default class Attachment extends BaseModel {
  static tableName = "tina4_rt_attachments";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    channel_id: { type: "integer" as const },
    message_id: { type: "integer" as const },
    storage_key: { type: "string" as const, required: true, maxLength: 255 },
    filename: { type: "string" as const, maxLength: 255 },
    mime: { type: "string" as const, maxLength: 128 },
    size: { type: "integer" as const },
    thumb_key: { type: "string" as const, maxLength: 255 },
  };
}

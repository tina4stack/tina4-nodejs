import { BaseModel } from "../../baseModel.js";

/**
 * ChannelMember - a user's membership of a channel plus their read cursor.
 * user_id is a string so it holds any identity shape the app puts in the JWT
 * (an integer id, a UUID, an email). last_read_at is the read-receipt cursor.
 */
export default class ChannelMember extends BaseModel {
  static tableName = "tina4_rt_channel_members";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    channel_id: { type: "integer" as const },
    user_id: { type: "string" as const, required: true, maxLength: 128 },
    role: { type: "string" as const, default: "member", maxLength: 20 },
    last_read_at: { type: "datetime" as const },
  };
}

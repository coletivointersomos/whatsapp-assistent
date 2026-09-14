/** Envelope OpenWA/Hermes-bridge, alinhado ao ingest do lab (sem secrets). */
export type OpenWaMedia = {
  data?: string;
  mimetype?: string;
};

export type OpenWaContact = {
  id?: string;
  pushname?: string;
  name?: string;
};

export type OpenWaMessageData = {
  id?: string;
  messageId?: string;
  chatId?: string;
  from?: string;
  author?: string;
  participant?: string;
  participantId?: string;
  sender?: string;
  fromMe?: boolean;
  isGroup?: boolean;
  isStatusBroadcast?: boolean;
  body?: string;
  caption?: string;
  type?: string;
  mentionedIds?: string[];
  mentionedJidList?: string[];
  timestamp?: number | string;
  media?: OpenWaMedia;
  contact?: OpenWaContact;
};

export type OpenWaEnvelope = {
  event?: string;
  sessionId?: string;
  data?: OpenWaMessageData;
};

export type ChannelDriver = {
  id: string;
  name?: string;
  jids: string[];
  vehicleHint?: string;
};

export type ChannelConversation = {
  conversationId: string;
  role: "motorista" | "central";
  driverId?: string;
  /** JIDs do motorista principal neste grupo/chat. */
  driverJids?: string[];
  label?: string;
};

export type ChannelConfig = {
  sessionId: string;
  adminIds: string[];
  botIds: string[];
  drivers?: ChannelDriver[];
  /** JID do único chat que pode receber envio real neste teste controlado. */
  testGroupJid?: string;
  conversations: ChannelConversation[];
};

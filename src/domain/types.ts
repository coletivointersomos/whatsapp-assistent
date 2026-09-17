export type AuthorRole = "alana" | "motorista" | "bot" | "desconhecido";
export type ConversationRole = "motorista" | "central";
export type MessageType = "texto" | "audio_info" | "anexo_comprovante";
export type RecordKind = "abastecimento" | "despesa" | "viagem";
export type RecordStatus = "incompleto" | "completo" | "descartado";
export type CommandStatus = "ambigua" | "aplicada" | "recusada" | "falha";
export type SuspensionStatus = "aplicada" | "encerrada" | "cancelada";

export type Driver = {
  id: string;
  name: string;
  vehicleHint?: string;
  /** JIDs WhatsApp do motorista (participante). Identidade não vem do texto. */
  jids?: string[];
};

export type Admin = {
  id: string;
  name: string;
  /** JIDs WhatsApp da Alana/admin. */
  jids?: string[];
};

export type Conversation = {
  id: string;
  role: ConversationRole;
  externalId: string;
  driverId?: string;
  active: boolean;
};

export type InboundMessage = {
  externalId: string;
  conversationId: string;
  authorId: string;
  authorRole: AuthorRole;
  /** Participante do grupo (`author` / `participant` OpenWA). Em 1:1 coincide com authorId. */
  participantId?: string;
  sentAt: string;
  type: MessageType;
  text?: string;
  attachmentRef?: string;
  raw?: unknown;
};

export type StoredMessage = InboundMessage & {
  processedAt: string;
};

export type RejectedMessage = {
  externalId: string;
  conversationId: string;
  reason: "unauthorized_conversation";
  receivedAt: string;
};

export type AbastecimentoFields = {
  date?: string;
  liters?: number;
  totalBrl?: number;
  place?: string;
  payment?: string;
  note?: string;
  vehicle?: string;
};

export type DespesaFields = {
  date?: string;
  amountBrl?: number;
  description?: string;
  payment?: string;
  note?: string;
  vehicle?: string;
};

export type ViagemFields = {
  date?: string;
  origin?: string;
  destination?: string;
  material?: string;
  quantity?: number;
  unit?: string;
  note?: string;
  vehicle?: string;
  unitPrice?: number;
  freightTotal?: number;
  receipt?: string;
};

export type OperationalRecord = {
  id: string;
  kind: RecordKind;
  driverId: string;
  status: RecordStatus;
  sourceMessageIds: string[];
  missing: string[];
  abastecimento?: AbastecimentoFields;
  despesa?: DespesaFields;
  viagem?: ViagemFields;
};

export type ConversationPause = {
  conversationId: string;
  reason: "intervencao_alana";
  silenceUntil: string;
  lastAlanaMessageId: string;
};

/** Adiamento leve do motorista. Sem scheduler: só evita insistir na hora. */
export type DriverDeferral = {
  conversationId: string;
  recordId?: string;
  reason: "motorista_adiou";
  messageId: string;
  deferredAt: string;
};

/** Texto livre do motorista sobre a viagem (sem GPS). */
export type OperationalStatusUpdate = {
  id: string;
  conversationId: string;
  driverId?: string;
  tripRecordId?: string;
  text: string;
  sentAt: string;
  sourceMessageId: string;
};

export type Suspension = {
  id: string;
  driverId: string;
  start: string;
  end: string;
  authorId: string;
  status: SuspensionStatus;
  commandText: string;
  messageId: string;
};

export type CentralCommand = {
  id: string;
  messageId: string;
  interpretation: string;
  status: CommandStatus;
  detail?: string;
};

export type BotReply = {
  conversationId: string;
  text: string;
  silentResume?: boolean;
  /** Retomada controlada (POST /resume). Não usar só o texto da pergunta para dedupe. */
  purpose?: "resume_pending_question";
  recordId?: string;
  missingKey?: string;
};

export type AppState = {
  admin: Admin;
  /** JIDs da sessão/bot. Mensagens desses JIDs são ignoradas (não pausam, não extraem). */
  botIds: string[];
  drivers: Driver[];
  conversations: Conversation[];
  messages: StoredMessage[];
  rejected: RejectedMessage[];
  records: OperationalRecord[];
  pauses: ConversationPause[];
  statusUpdates: OperationalStatusUpdate[];
  deferrals: DriverDeferral[];
  suspensions: Suspension[];
  commands: CentralCommand[];
  botReplies: BotReply[];
};

export type ProcessDecision =
  | "duplicate"
  | "rejected_unauthorized"
  | "pause_updated"
  | "record_created"
  | "record_incomplete"
  | "deferred"
  | "command_applied"
  | "command_ambiguous"
  | "command_refused"
  | "attachment_stored"
  | "assisted"
  | "ignored";

export type ProcessResult = {
  decision: ProcessDecision;
  duplicate: boolean;
  message?: StoredMessage;
  record?: OperationalRecord;
  replies: BotReply[];
  pause?: ConversationPause;
  deferral?: DriverDeferral;
  suspension?: Suspension;
  command?: CentralCommand;
  rejected?: RejectedMessage;
};

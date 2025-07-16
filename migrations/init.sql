create extension if not exists vector with schema public;

CREATE TABLE public.memories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  memory      TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);


CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


CREATE INDEX idx_conversations_session_id ON conversations(session_id, created_at);
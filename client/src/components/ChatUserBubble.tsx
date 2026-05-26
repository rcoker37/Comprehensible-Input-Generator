interface Props {
  text: string;
}

export default function ChatUserBubble({ text }: Props) {
  return (
    <div className="chat-msg chat-msg--user">
      <div className="chat-msg-bubble">{text}</div>
    </div>
  );
}

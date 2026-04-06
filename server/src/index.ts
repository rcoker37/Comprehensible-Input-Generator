import express from "express";
import cors from "cors";
import kanjiRouter from "./routes/kanji.js";
import storiesRouter from "./routes/stories.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

app.use(cors());
app.use(express.json());

app.use("/api/kanji", kanjiRouter);
app.use("/api/stories", storiesRouter);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});

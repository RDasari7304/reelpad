import { Router } from "express";
import { roomProfile, roomState } from "../services/room.js";
import { asyncHandler, HttpError } from "./util.js";

export const roomRouter = Router();

/** Who's in the Room and the conversations happening now (with timing, so every viewer sees the same thing). */
roomRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await roomState());
  }),
);

/** A character's public profile for the Room's side panel. */
roomRouter.get(
  "/characters/:id",
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, "Character not found");
    const p = await roomProfile(id);
    if (!p) throw new HttpError(404, "Character not found");
    res.set("Cache-Control", "public, max-age=20");
    res.json(p);
  }),
);

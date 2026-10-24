import bcrypt from "bcryptjs";
import type { Request, Response } from "express";
import { prisma } from "../db.js";
import { authSchema } from "../types/auth-schema.js";
import { createToken } from "../utils/auth.js";
import { sendValidationError } from "../utils/validation.js";
import jwt from 'jsonwebtoken';
import "dotenv/config";

const secret = `${process.env.JWT_SECRET}`;
if(!secret){
  throw new Error("Invalid secret key")
}

export async function signup(req: Request, res: Response): Promise<void> {
  const parsedBody = authSchema.safeParse(req.body);
  if (!parsedBody.success) {
    sendValidationError(res, parsedBody.error);
    return;
  }

  const { username, password } = parsedBody.data;
  const hashedPassword = await bcrypt.hash(password, 10);

  try {
    const user = await prisma.user.create({
      data: {
        username,
        password: hashedPassword,
      },
    });

    res.status(201).json({
      token: createToken({ userId: user.id }),
      userId: user.id,
      username: user.username,
    });
  } catch {
    res.status(409).json({ error: "username already exists" });
  }
}

export async function signin(req: Request, res: Response): Promise<void> {
  //TODO: Implement signin logic
  //1. check request
  // 2. find the userexist in db
  // 3. set the header (bearer)
  // 4. next();

  const parsedBody = authSchema.safeParse(req.body);
  if (!parsedBody.success) {
    sendValidationError(res, parsedBody.error);
    return;
  }
  const {username, password} = parsedBody.data;
 
  const validate = await prisma.user.findUnique({where : { username}});
  console.log(validate);
  if(!validate){
    res.status(409).json("invalid username , password");
    return;
  }
  const validpassword = await bcrypt.compare(password, validate.password);
  if(!validpassword){
    res.send("invalid username, password");
    return;
  }

  const token = jwt.sign({userId : validate.id},secret);
  const bearer = `Bearer ${token}`;
  req.userId = validate.id;
  res.set("authorization", bearer);
  res.json({ message : "login successful", token : bearer});


}

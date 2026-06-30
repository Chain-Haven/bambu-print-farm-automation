// src/utils/uuid.js — UUID generation
import { v4 as uuidv4 } from 'uuid';
export function generateId() { return uuidv4(); }
export default generateId;

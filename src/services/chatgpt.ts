import logger from '../logger';
import OpenAI, { toFile } from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources';
import { CONFIG } from '../config';

// Interface for tracking user messages
interface UserMessageCount {
  count: number;
  lastResetDate: string; // Store as YYYY-MM-DD format
}

export class ChatGTP {
  private openai: OpenAI;
  private readonly gptModel: string;
  private userMessageCounts: Map<string, UserMessageCount>;
  private readonly MAX_MESSAGES_PER_DAY = 7;

  constructor() {
    this.openai = new OpenAI({
      apiKey: CONFIG.openAI.apiKey,
    });
    this.gptModel = <string>process.env.GPT_MODEL;
    this.userMessageCounts = new Map();
  }

  private getCurrentDateWIB(): string {
    // Create date in WIB (UTC+7)
    const date = new Date();
    date.setHours(date.getHours() + 7);
    return date.toISOString().split('T')[0];
  }

  private resetUserCountIfNeeded(userId: string) {
    const userCount = this.userMessageCounts.get(userId);
    const currentDate = this.getCurrentDateWIB();
    
    if (!userCount || userCount.lastResetDate !== currentDate) {
      this.userMessageCounts.set(userId, {
        count: 0,
        lastResetDate: currentDate
      });
    }
  }

  private async checkMessageLimit(userId: string): Promise<boolean> {
    this.resetUserCountIfNeeded(userId);
    const userCount = this.userMessageCounts.get(userId)!;
    
    if (userCount.count >= this.MAX_MESSAGES_PER_DAY) {
      logger.debug(`[ChatGTP->checkMessageLimit] User ${userId} has reached daily message limit`);
      return false;
    }
    
    userCount.count++;
    this.userMessageCounts.set(userId, userCount);
    return true;
  }

  async sendCompletion(messageList: ChatCompletionMessageParam[], systemPrompt: string, userId: string) {
    if (!await this.checkMessageLimit(userId)) {
      throw new Error('Daily message limit reached. Please try again tomorrow after 12 AM WIB.');
    }

    logger.debug(`[ChatGTP->sendCompletion] Sending ${messageList.length} messages for user ${userId}`);

    messageList.unshift({role: 'system', content:systemPrompt});

    const completion = await this.openai.chat.completions.create({
      model: CONFIG.openAI.chatCompletionModel,
      messages: messageList,
      max_tokens: 512,
      temperature: 0.7,
      top_p: 0.9,
      frequency_penalty: 0.0,
      presence_penalty: 0.0
    });

    logger.debug('[ChatGTP->sendCompletion] Completion Response:');
    logger.debug(completion.choices[0]);

    const messageResult = completion.choices[0].message;

    return messageResult?.content || '';
  }

  // Other methods remain unchanged...

  /**
   * Requests the generation of an image based on a textual description, by interacting with OpenAI's image generation API.
   * This function takes a prompt in the form of text and sends a request to generate an image that corresponds with the text description provided.
   * It aims to utilize OpenAI's capabilities to create visually representative images based on textual inputs.
   *
   * Parameters:
   * - message: A string containing the text description that serves as the prompt for image generation.
   *
   * Returns:
   * - A promise that resolves to the URL of the generated image. This URL points to the image created by OpenAI's API based on the input prompt.
   */
  async createImage(message){

    logger.debug(`[ChatGTP->createImage] Creating message for: "${message}"`);

    const response = await this.openai.images.generate({
      model: CONFIG.openAI.imageCreationModel,
      prompt: message,
      quality: 'standard',
      n: 1,
      size: "1024x1024",
    });
    return response.data[0].url;
  }

  /**
   * Generates speech audio from provided text by utilizing OpenAI's Text-to-Speech (TTS) API.
   * This function translates text into spoken words in an audio format. It offers a way to convert written messages into audio, providing an audible version of the text content.
   * If a specific voice model is specified in the configuration, the generated speech will use that voice.
   *
   * Parameters:
   * - message: A string containing the text to be converted into speech. This text serves as the input for the TTS engine.
   *
   * Returns:
   * - A promise that resolves to a buffer containing the audio data in MP3 format. This buffer can be played back or sent as an audio message.
   */
  async speech(message, responseFormat?){

    logger.debug(`[ChatGTP->speech] Creating speech audio for: "${message}"`);

    const response: any = await this.openai.audio.speech.create({
      model: CONFIG.openAI.speechModel,
      voice: <any>CONFIG.openAI.speechVoice,
      input: message,
      response_format: responseFormat || 'mp3'
    });

    logger.debug(`[ChatGTP->speech] Audio Creation OK`);

    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Transcribes audio content into text using OpenAI's transcription capabilities.
   * This function takes an audio file and sends a request to OpenAI's API to generate a textual representation of the spoken words.
   * It leverages the Whisper model for high-quality transcription, converting audio inputs into readable text output.
   *
   * Parameters:
   * - message: A string indicating the audio file path or description for logging purposes. Currently, it is not used in the function's implementation but can be helpful for future extensions or logging clarity.
   *
   * Returns:
   * - A promise that resolves to a string containing the transcribed text. This string is the result of processing the provided audio through OpenAI's transcription model.
   *
   * Throws:
   * - Any errors encountered during the process of reading the audio file or interacting with OpenAI's API will be thrown and should be handled by the caller function.
   */
  async transcription(stream: any) {
    logger.debug(`[ChatGTP->transcription] Creating transcription text for audio"`);
    try {
      // Convertir ReadStream a File o Blob
      const file = await toFile(stream, 'audio.ogg', { type: 'audio/ogg' });
      // Enviar el archivo convertido a la API de transcripción
      const response = await this.openai.audio.transcriptions.create({
        file: file,
        model: "whisper-1",
        language: CONFIG.openAI.transcriptionLanguage
      });
      return response.text;
    } catch (e: any) {
      logger.error(e.message);
      throw e;
    }
  }

}

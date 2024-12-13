import { ChatGTP } from './services/chatgpt';
import { Chat, Client, Message, MessageMedia, MessageTypes } from 'whatsapp-web.js';
import { addNameToMessage, bufferToStream, getContactName, includeName, logMessage, parseCommand } from './utils';
import logger from './logger';
import { CONFIG } from './config';
import { AiContent, AiLanguage, AiMessage, AiRole } from './interfaces/ai-message';
import Anthropic from '@anthropic-ai/sdk';
import { ChatCompletionMessageParam } from 'openai/resources';
import OpenAI from 'openai';
import { Claude } from './services/claude';
import { ImageBlockParam, TextBlock } from '@anthropic-ai/sdk/src/resources/messages';
import NodeCache from 'node-cache';
import MessageParam = Anthropic.MessageParam;
import ChatCompletionContentPart = OpenAI.ChatCompletionContentPart;

export class Roboto {
  private chatGpt: ChatGTP;
  private claude: Claude;
  private botConfig = CONFIG.botConfig;
  private allowedTypes = [MessageTypes.STICKER, MessageTypes.TEXT, MessageTypes.IMAGE, MessageTypes.VOICE, MessageTypes.AUDIO];
  private cache: NodeCache;

  public constructor() {
    this.chatGpt = new ChatGTP();
    this.claude = new Claude();
    this.cache = new NodeCache();
  }

  private getUserId(message: Message): string {
    return `whatsapp-${message.from}`;
  }

  public async readMessage(message: Message, client: Client) {
    try {
      const chatData: Chat = await message.getChat();
      const isAudioMsg = message.type == MessageTypes.VOICE || message.type == MessageTypes.AUDIO;
      const { command, commandMessage } = parseCommand(message.body);

      if(chatData.id.user == 'status' || chatData.id._serialized == 'status@broadcast') return false;
      if(!this.allowedTypes.includes(message.type) || (isAudioMsg && !this.botConfig.voiceMessagesEnabled)) return false;

      const isSelfMention = message.hasQuotedMsg ? (await message.getQuotedMessage()).fromMe : false;
      const isMentioned = includeName(message.body, this.botConfig.botName);

      if(!isSelfMention && !isMentioned && !command && chatData.isGroup) return false;

      logMessage(message, chatData);

      if(!!command){
        await chatData.sendStateTyping();
        await this.commandSelect(message, chatData);
        await chatData.clearState();
        return true;
      }

      chatData.sendStateTyping();
      let chatResponseString = await this.processMesage(message, chatData);
      chatData.clearState();

      if(!chatResponseString) return;

      if (chatResponseString.startsWith('[Audio]')) {
        chatResponseString = chatResponseString.replace('[Audio]','').trim();
        return this.fallbackToText(message, chatData, chatResponseString);
      } else {
        chatResponseString = chatResponseString.replace('[Text]','').trim();
        return this.returnResponse(message, chatResponseString, chatData.isGroup, client);
      }

    } catch (e: any) {
      logger.error(e.message);
      return message.reply('Maaf....😔 Aku lagi gabisa bantu kamu lagi nih!.. Coba lagi besok yaaa.....');
    }
  }

  private async commandSelect(message: Message, chatData: Chat) {
    const { command, commandMessage } = parseCommand(message.body);
    if (command === "image") {
      if (!this.botConfig.imageCreationEnabled) return;
      return message.reply("Image generation is currently not available.");
    }
    return true;
  }

  private async processMesage(message: Message, chatData: Chat) {
    const actualDate = new Date();
    const messageList: AiMessage[] = [];
    const fetchedMessages = await chatData.fetchMessages({ limit: this.botConfig.maxMsgsLimit });
    const resetIndex = fetchedMessages.map(msg => msg.body).lastIndexOf("-reset");
    const messagesToProcess = resetIndex >= 0 ? fetchedMessages.slice(resetIndex + 1) : fetchedMessages;

    for (const msg of messagesToProcess) {
      const msgDate = new Date(msg.timestamp * 1000);
      const timeDifferenceHours = (actualDate.getTime() - msgDate.getTime()) / (1000 * 60 * 60);
      if (timeDifferenceHours > this.botConfig.maxHoursLimit) continue;

      const isImage = msg.type === MessageTypes.IMAGE || msg.type === MessageTypes.STICKER;
      const isAudio = msg.type === MessageTypes.VOICE || msg.type === MessageTypes.AUDIO;
      if ((!this.allowedTypes.includes(msg.type) && !isAudio) || (isAudio && !this.botConfig.voiceMessagesEnabled)) continue;
      if ((msg.fromMe && isImage)) continue;

      const media = isImage || isAudio ? await msg.downloadMedia() : null;
      const role = msg.fromMe ? AiRole.ASSISTANT : AiRole.USER;
      const name = msg.fromMe ? (CONFIG.botConfig.botName) : (await getContactName(msg));

      const content: Array<AiContent> = [];
      if (isAudio && media) {
        content.push({ type: 'text', value: '[Text]<Voice message received - transcription not available>' });
      }
      if (isImage && media) content.push({ type: 'image', value: media.data, media_type: media.mimetype });
      if (msg.body) content.push({ type: 'text', value: '[Text]' + msg.body });

      messageList.push({ role: role, name: name, content: content });
    }

    if (messageList.length == 0) return;

    if (CONFIG.botConfig.aiLanguage == AiLanguage.OPENAI) {
      const convertedMessageList: ChatCompletionMessageParam[] = this.convertIaMessagesLang(messageList, AiLanguage.OPENAI, chatData.isGroup) as ChatCompletionMessageParam[];
      return await this.chatGpt.sendCompletion(convertedMessageList, this.botConfig.prompt, this.getUserId(message));
    } else if (CONFIG.botConfig.aiLanguage == AiLanguage.ANTHROPIC) {
      const convertedMessageList: MessageParam[] = this.convertIaMessagesLang(messageList, AiLanguage.ANTHROPIC, chatData.isGroup) as MessageParam[];
      return await this.claude.sendChat(convertedMessageList, this.botConfig.prompt);
    }
  }

  private async fallbackToText(message: Message, chatData: Chat, content: string) {
    const response = `I can't generate audio right now. Here's your message as text:\n\n${content}`;
    return this.returnResponse(message, response, chatData.isGroup, undefined);
  }

  private async getLastBotMessage(chatData: Chat) {
    const lastMessages = await chatData.fetchMessages({limit: 12});
    let lastMessageBot: string = '';
    for (const msg of lastMessages) {
      if(msg.fromMe && msg.body.length>1) lastMessageBot = msg.body;
    }
    return lastMessageBot;
  }

  private convertIaMessagesLang(messageList: AiMessage[], lang: AiLanguage, isGroup: boolean): MessageParam[] | ChatCompletionMessageParam[] {
    switch (lang) {
      case AiLanguage.ANTHROPIC:
        const claudeMessageList: MessageParam[] = [];
        let currentRole: AiRole = AiRole.USER;
        let gptContent: Array<TextBlock | ImageBlockParam> = [];
        
        messageList.forEach((msg, index) => {
          const role = msg.role === AiRole.ASSISTANT && msg.content.find(c => c.type === 'image') ? AiRole.USER : msg.role;
          if (role !== currentRole) {
            if (gptContent.length > 0) {
              claudeMessageList.push({ role: currentRole, content: gptContent });
              gptContent = [];
            }
            currentRole = role;
          }

          msg.content.forEach(c => {
            if (c.type === 'text') gptContent.push({ type: 'text', text: isGroup? addNameToMessage(msg.name, c.value) : c.value });
            else if (c.type === 'image') gptContent.push({ type: 'image', source: { data: <string>c.value, media_type: c.media_type as any, type: 'base64' } });
          });
        });

        if (gptContent.length > 0) claudeMessageList.push({ role: currentRole, content: gptContent });

        if (claudeMessageList.length > 0 && claudeMessageList[0].role !== AiRole.USER) {
          claudeMessageList.shift();
        }

        return claudeMessageList;

      case AiLanguage.OPENAI:
        const chatgptMessageList: any[] = [];
        messageList.forEach(msg => {
          const gptContent: Array<ChatCompletionContentPart> = [];
          msg.content.forEach(c => {
            if(c.type == 'image') gptContent.push({ type: 'image_url', image_url: { url: `data:${c.media_type};base64,${c.value}`} });
            if(c.type == 'text') gptContent.push({ type: 'text', text: <string> c.value });
          })
          chatgptMessageList.push({content: gptContent, name: msg.name, role: msg.role});
        })
        return chatgptMessageList;

      default:
        return [];
    }
  }

  private returnResponse(message, responseMsg, isGroup, client) {
    if(isGroup) return message.reply(responseMsg);
    else return client.sendMessage(message.from, responseMsg);
  }
}
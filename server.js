// DATN-backend-nodejs/server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json());

// ✅ Cấu hình CORS
const allowedOrigins = [
  "http://localhost:3000",
  "http://26.112.109.171:3000",
  "https://travelsuggest-app-36bf8.web.app",
];

const isDev = process.env.NODE_ENV !== "production";

if (isDev) {
  // Dev mode: cho phép tất cả
  app.use(cors());
} else {
  // Prod mode: chỉ cho phép origin trong danh sách
  app.use(
    cors({
      origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error("Not allowed by CORS"));
        }
      },
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    })
  );
}

// ✅ Xử lý preflight cho tất cả route
app.options("*", cors());

const PORT = process.env.PORT || 3001;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Thay thế toàn bộ khối app.post hiện tại bằng đoạn mã sau
app.post('/api/get-recommendations', async (req, res) => {
  try {
    const { accountId, location, userUpdate } = req.body;

    // Server check: Đảm bảo các trường bắt buộc không bị thiếu
    if (!accountId || !location) {
      return res.status(400).json({ error: "Thiếu accountId hoặc location" });
    }

    // 1. Gọi API Spring Boot để cập nhật user
    let userProfile = null;
    if (userUpdate) {
      // THAY ĐỔI LỚN: Chỉ gửi các trường dữ liệu liên quan để cập nhật
      const filteredUserUpdate = {
        travelStyles: userUpdate.travelStyles,
        interests: userUpdate.interests,
        budget: userUpdate.budget,
        companions: userUpdate.companions,
      };

      const updateResponse = await axios.put(
        `https://datn-0v3f.onrender.com/api/accounts/user/${accountId}`,
        filteredUserUpdate,
        { headers: { "Content-Type": "application/json" } }
      );
      userProfile = updateResponse.data; // JSON response từ Spring Boot
    } else {
      return res.status(400).json({ error: "Thiếu dữ liệu userUpdate để cập nhật" });
    }

    // 2. Lấy thông tin thời tiết
    const weatherResponse = await axios.get(`https://api.openweathermap.org/data/2.5/weather`, {
      params: {
        lat: location.lat,
        lon: location.lng,
        appid: process.env.OPENWEATHERMAP_API_KEY,
        units: 'metric',
        lang: 'vi'
      }
    });
    const weather = {
      description: weatherResponse.data.weather[0].description,
      temp: weatherResponse.data.main.temp
    };

    const now = new Date();
    const timeOfDay = `${now.getHours()}:${now.getMinutes()}`;

    // 3. Prompt AI
    const dynamicPrompt = `
      Bạn là hệ thống AI. Hãy TRẢ VỀ DUY NHẤT một JSON hợp lệ, không có text giải thích, không markdown.

      Yêu cầu: Đưa ra gợi ý 3-5 địa điểm du lịch với tọa độ phải chính xác xung quanh vị trí hiện tại trong chính xác bán kính 5km và viết thêm lý do tại sao lại chọn địa điểm như thế phải giải thích súc tích, trong đó **nêu bật được ưu điểm chính của địa điểm và lý giải tại sao những ưu điểm đó lại đặc biệt phù hợp với hồ sơ cá nhân của người dùng** (dựa trên sở thích, phong cách, ngân sách, người đi cùng) và địa điểm có gì với những địa điểm khác.

      Dữ liệu JSON phải có cấu trúc:
      {
        "recommendations": [
          {
            "name": "Tên địa điểm",
            "location": "Địa chỉ chi tiết",
            "lat": xx.xxxx,
            "lng": xxx.xxxx,
            "reason":"Lý do chọn, nêu bật ưu điểm, sự phù hợp với cá nhân người dùng và ưu điểm so với địa điểm khác."
          }
        ]
      }

      Thông tin người dùng:
      - Sở thích: ${userProfile.interests?.join(', ') || "Không rõ"}
      - Phong cách: ${userProfile.travelStyles?.join(', ') || "Không rõ"}
      - Ngân sách: ${userProfile.budget || "Không rõ"}
      - Đi cùng: ${userProfile.companions?.join(', ') || "Không rõ"}

      Ngữ cảnh:
      - Vị trí hiện tại: ${location.lat}, ${location.lng}
      - Thời gian: ${timeOfDay}
      - Thời tiết: ${weather.temp}°C, trời ${weather.description}

      ⚠️ Quan trọng: 
      - KHÔNG được trả lời thêm chữ nào ngoài JSON.
      - LUÔN có trường "lat" và "lng" là số thực.
    `;

    // 4. Gọi Gemini
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    const result = await model.generateContent(dynamicPrompt);
    const geminiText = (await result.response.text()).trim();

    // 5. Parse JSON
    let recommendations = [];
    try {
      let cleanText = geminiText;
      cleanText = cleanText.replace(/```json/gi, "").replace(/```/g, "").trim();
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (jsonMatch) cleanText = jsonMatch[0];
      const parsed = JSON.parse(cleanText);
      recommendations = parsed.recommendations || [];
    } catch (err) {
      console.error("Không parse được JSON từ Gemini:", geminiText);
    }

    // 6. Trả về kết quả
    res.json({
      narrative: "Gợi ý từ AI",
      places: recommendations,
      updatedUser: userProfile
    });

  } catch (error) {
    console.error("Lỗi tại Backend:", error.message);
    res.status(500).json({ error: "Đã có lỗi xảy ra phía máy chủ." });
  }
});

app.post('/api/analyze-performance', async (req, res) => {
  try {
    const { companyId, message, history, token } = req.body; // Lấy token từ client

    if (!companyId || !message || !token) {
      return res.status(400).json({ error: "Thiếu companyId, message hoặc token" });
    }

    // 1. Gọi API Spring Boot để lấy dữ liệu hiệu suất, kèm Bearer token
    console.log(`Đang lấy dữ liệu cho công ty ID: ${companyId}...`);
    const dataResponse = await axios.post(
      `http://localhost:8080/api/data-aggregation/snapshot`,
      { companyId },
      {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}` // Thêm token ở đây
        }
      }
    );
    const performanceData = dataResponse.data; // Dữ liệu JSON từ Spring Boot
    console.log("Lấy dữ liệu thành công!");

    // 2. Xây dựng Prompt hoàn chỉnh cho Gemini
    const fullPrompt = `Bạn là một Nhà phân tích Dữ liệu và Chiến lược gia Kinh doanh chuyên nghiệp trong ngành du lịch và khách sạn.
      Mục tiêu của bạn là phân tích dữ liệu hiệu suất và cung cấp những hiểu biết rõ ràng, ngắn gọn và có thể hành động để giúp các chủ doanh nghiệp cải thiện hiệu suất của họ trên nền tảng TravelSuggest.
      Giọng điệu của bạn chuyên nghiệp, khách quan và hữu ích. Sử dụng tiếng Việt.
      Chỉ dựa vào dữ liệu được cung cấp trong ngữ cảnh để phân tích. Không tự bịa đặt dữ liệu. Khi được yêu cầu đề xuất, hãy cung cấp một danh sách được đánh số các hành động cụ thể. Định dạng câu trả lời bằng markdown để dễ đọc.

      DỮ LIỆU NGỮ CẢNH:
      \`\`\`json
      ${JSON.stringify(performanceData, null, 2)}
      \`\`\`

      DỰA VÀO DỮ LIỆU TRÊN, HÃY TRẢ LỜI CÂU HỎI SAU:
      "${message}"
      `;

    // 3. Gọi Gemini API và streaming kết quả
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); 
    const result = await model.generateContent(fullPrompt);
    const geminiText = (await result.response.text()).trim();

    // 4. Pipe stream từ Gemini thẳng về cho client
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    for await (const chunk of result.stream) {
      res.write(chunk.text());
    }

    res.end();

  } catch (error) {
    console.error("Lỗi tại Server AI (Node.js):", error);
    res.status(500).json({ error: "Đã có lỗi xảy ra phía máy chủ AI." });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server Node.js đang chạy tại http://localhost:${PORT}`);
});

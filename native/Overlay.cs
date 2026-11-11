// Windows companion: display only. It has no API for editing or saving files.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace CodeSwarmNative {
  static class Win {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; public int Width { get { return Right-Left; } } public int Height { get { return Bottom-Top; } } }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int capacity);
    public static string Title(IntPtr h){var text=new StringBuilder(1024);GetWindowText(h,text,text.Capacity);return text.ToString();}
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int value);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("dwmapi.dll")] public static extern int DwmFlush();
    public static RECT Client(IntPtr h) { RECT r; POINT p=new POINT(); GetClientRect(h,out r);ClientToScreen(h,ref p);r.Left=p.X;r.Top=p.Y;r.Right+=p.X;r.Bottom+=p.Y;return r; }
    public static bool IsCode(IntPtr h) { uint pid;GetWindowThreadProcessId(h,out pid);try { var n=Process.GetProcessById((int)pid).ProcessName;return n.Equals("Code",StringComparison.OrdinalIgnoreCase)||n.Equals("Code - Insiders",StringComparison.OrdinalIgnoreCase); } catch{return false;} }
  }
  class Anchor { public double X,Y,Height; }
  class Job {
    public string Kind,Text,Visual,OldText,Key; public int Worker; public double Start,End,X,Y,FromX,FromY,Width,Height,CursorX,LastTick;
    public int Index,Line,Variant,Steps,SentStep; public bool Incoming,Controlled;public string Ticket;public double Begin,Span,SX,SY,CardW,CardH,LastX,LastY,LastW,LastH,LastP;
  }
  class Ghost { public string Text,Color;public double X,Y,W,H,At; }
  class CodeToken {public string Text,Color;}
  class Surface : FrameworkElement {
    public Action<DrawingContext> Paint;
    protected override void OnRender(DrawingContext dc) { if(Paint!=null)Paint(dc); }
  }
  class Overlay : Window {
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength=1000000 };
    readonly object outputLock=new object();
    readonly Surface surface=new Surface();
    readonly Stopwatch watch=Stopwatch.StartNew();
    readonly List<Job> jobs=new List<Job>();
    readonly List<Ghost> ghosts=new List<Ghost>();
    readonly Dictionary<string,FormattedText> formatted=new Dictionary<string,FormattedText>();
    readonly Dictionary<string,CodeToken[]> tokenized=new Dictionary<string,CodeToken[]>();
    static readonly HashSet<string> keywords=new HashSet<string>{"def","class","return","if","else","for","in","import","from","with","try","except","async","await"};
    static readonly Dictionary<string,SolidColorBrush> brushes=new Dictionary<string,SolidColorBrush>();
    readonly string[] colors={"#C5F879","#72D8E6","#B59AFF","#F8BD7A","#FA8BA6","#79AFFF","#9FDDB5","#D9A1E6"};
    readonly DispatcherTimer pulse=new DispatcherTimer { Interval=TimeSpan.FromMilliseconds(16) };
    IntPtr owner,handle; Win.RECT client; bool allowed=true, measuring=false; double started,pointerSize=12,zoom=1,lineHeight=21; int maxActive=0;
    uint probeDpi;
    bool cardsMode,holding;double holdAt,sceneLeft,sceneRight,sceneTop,sceneBottom;
    string modeName="cues";double sourceFontSize=14;int appendedBatches,typeMerges,droppedJobs;
    int typingFrames;double typingDistance;
    int paintedLastFrame;readonly HashSet<string> seenMotions=new HashSet<string>();readonly HashSet<int> originSides=new HashSet<int>();
    int performedActs,actSignals;
    bool selfTest,inspection; Window testWindow;
    Dictionary<string,Anchor> anchors=new Dictionary<string,Anchor>();
    public Overlay(bool test,bool inspect) {
      selfTest=test;inspection=inspect;Title="Code Swarm Native Overlay";WindowStyle=WindowStyle.None;AllowsTransparency=true;Background=Brushes.Transparent;
      ResizeMode=ResizeMode.NoResize;ShowInTaskbar=inspect;ShowActivated=false;Focusable=false;Topmost=true;IsHitTestVisible=false;
      Width=1;Height=1;Left=-30000;Top=-30000;Content=surface;
      surface.Paint=Paint;
      SourceInitialized+=(s,e)=>{
        handle=new WindowInteropHelper(this).Handle;
        // Layered + transparent is actual Win32 mouse passthrough, not just WPF hit testing.
        int style=Win.GetWindowLong(handle,-20)|0x80000|0x20|0x8000000;
        Win.SetWindowLong(handle,-20,inspect?(style&~0x80)|0x40000:style|0x80);
      };
      Loaded+=(s,e)=>{
        Hide();Emit(new{type="ready",pid=Process.GetCurrentProcess().Id,protocol=1});
        if(selfTest)BeginSelfTest();else{
          var thread=new Thread(ReadInput);thread.IsBackground=true;thread.Start();
        }
        pulse.Tick+=Tick;pulse.Start();
      };
      Closed+=(s,e)=>{pulse.Stop();Application.Current.Shutdown();};
    }
    void Emit(object data){lock(outputLock){Console.WriteLine(json.Serialize(data));Console.Out.Flush();}}
    static string Str(IDictionary<string,object> o,string key,string fallback=""){object v;return o.TryGetValue(key,out v)&&v!=null?Convert.ToString(v,CultureInfo.InvariantCulture):fallback;}
    static double Num(IDictionary<string,object> o,string key,double fallback=0){object v;double n;return o.TryGetValue(key,out v)&&double.TryParse(Convert.ToString(v,CultureInfo.InvariantCulture),NumberStyles.Float,CultureInfo.InvariantCulture,out n)?n:fallback;}
    static IEnumerable<IDictionary<string,object>> Items(IDictionary<string,object> o,string key){object v;if(!o.TryGetValue(key,out v)||!(v is IEnumerable))yield break;foreach(var entry in (IEnumerable)v){var d=entry as IDictionary<string,object>;if(d!=null)yield return d;}}
    void ReadInput(){try{string line;while((line=Console.ReadLine())!=null){if(line.Length>900000)continue;var data=json.DeserializeObject(line) as IDictionary<string,object>;if(data!=null)Dispatcher.BeginInvoke(new Action(()=>Command(data)));}}catch(Exception e){Emit(new{type="error",message=e.Message});}Dispatcher.BeginInvoke(new Action(Close));}
    bool Bind(){var foreground=Win.GetForegroundWindow();if(owner==IntPtr.Zero){if(!Win.IsCode(foreground))return false;owner=foreground;}return Win.IsWindow(owner)&&!Win.IsIconic(owner)&&Win.GetForegroundWindow()==owner;}
    void Clear(string reason="cleared"){foreach(var j in jobs.Where(j=>j.Ticket!=null)){Emit(new{type="cancelled",requestId=j.Ticket,reason=reason});j.Ticket=null;}jobs.Clear();ghosts.Clear();holding=false;surface.InvalidateVisual();if(IsVisible)Hide();}
    void FloatScene(){if(cardsMode&&jobs.Count>0&&!holding){holding=true;holdAt=watch.Elapsed.TotalSeconds;}}
    void Command(IDictionary<string,object> data){
      try{
        switch(Str(data,"type")){
          case "stop":Close();break;
          case "clear":Clear(Str(data,"reason","cleared"));break;
          case "float":FloatScene();break;
          case "suspend":allowed=false;Clear("notForeground");break;
          case "resume":allowed=true;break;
          case "probe":Probe(data);break;
          case "play":Play(data);break;
          case "append":Append(data);break;
          case "perform":Perform(data);break;
          case "lineShift":Shift(data);break;
          case "rebase":foreach(var j in jobs){j.X+=Num(data,"dx");j.FromX+=Num(data,"dx");if(j.CursorX>0)j.CursorX+=Num(data,"dx");if(!j.Incoming){j.Y+=Num(data,"dy");j.FromY+=Num(data,"dy");}}break;
          case "status":Report(Str(data,"requestId"));break;
        }
      }catch(Exception e){Emit(new{type="error",requestId=Str(data,"requestId"),message=e.Message});Clear();}
    }
    void Probe(IDictionary<string,object> data){
      bool preserve=data.ContainsKey("preserve")&&Convert.ToBoolean(data["preserve"]);
      if(preserve){if(modeName!="hybrid")FloatScene();if(IsVisible){Hide();Win.DwmFlush();}}else Clear();
      bool reset=!data.ContainsKey("reset")||Convert.ToBoolean(data["reset"]);
      if(reset)anchors.Clear();
      var foreground=Win.GetForegroundWindow();
      if(owner==IntPtr.Zero&&(!Win.IsCode(foreground)||!Win.Title(foreground).Contains(Str(data,"file")))){Emit(new{type="anchors",requestId=Str(data,"requestId"),points=new object[0],reason="wrongWindow"});return;}
      if(!allowed||!Bind()){Emit(new{type="anchors",requestId=Str(data,"requestId"),points=new object[0],reason="notForeground"});return;}
      if(!Win.Title(owner).Contains(Str(data,"file"))){Emit(new{type="anchors",requestId=Str(data,"requestId"),points=new object[0],reason="wrongWindow"});return;}
      probeDpi=Win.GetDpiForWindow(owner);
      var measuredClient=Win.Client(owner);
      if(!reset&&(measuredClient.Width!=client.Width||measuredClient.Height!=client.Height)){anchors.Clear();Emit(new{type="anchors",requestId=Str(data,"requestId"),points=new object[0],reason="layout"});return;}
      client=measuredClient;if(client.Width<100||client.Height<100||client.Width>12000||client.Height>8000)return;
      measuring=true;
      try{
        var specs=Items(data,"markers").Take(64).ToArray();
        using(var bitmap=new System.Drawing.Bitmap(client.Width,client.Height,System.Drawing.Imaging.PixelFormat.Format32bppArgb)){
          using(var g=System.Drawing.Graphics.FromImage(bitmap))g.CopyFromScreen(client.Left,client.Top,0,0,new System.Drawing.Size(client.Width,client.Height));
          var bits=bitmap.LockBits(new System.Drawing.Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,System.Drawing.Imaging.PixelFormat.Format32bppArgb);
          try{
            int length=Math.Abs(bits.Stride)*bitmap.Height;var pixels=new byte[length];Marshal.Copy(bits.Scan0,pixels,0,length);
            DetectAnchors(pixels,Math.Abs(bits.Stride),bitmap.Width,bitmap.Height,specs,Num(data,"fontSize")*probeDpi/96.0);
          }finally{bitmap.UnlockBits(bits);}
        }
        Emit(new{type="anchors",requestId=Str(data,"requestId"),points=anchors.Select(p=>new{id=p.Key,x=p.Value.X,y=p.Value.Y,height=p.Value.Height}).ToArray(),width=client.Width,height=client.Height,dpi=probeDpi/96.0,title=Win.Title(owner)});
      }finally{measuring=false;if(preserve&&jobs.Count>0&&allowed&&Win.GetForegroundWindow()==owner){Reposition();Show();}}
    }
    void DetectAnchors(byte[] pixels,int stride,int width,int height,IDictionary<string,object>[] specs,double expectedSize){
      // Saturation + rectangular geometry survive a translucent/customized VS Code theme.
      // All marks are at column zero. Accept only one unambiguous column with the exact
      // requested count; ordering in the viewport maps it to logical line ordering.
      var mask=new byte[width*height];
      for(int y=0;y<height;y++)for(int x=0;x<width;x++){
        int p=y*stride+x*4;int b=pixels[p],g=pixels[p+1],r=pixels[p+2];
        if(g>120&&g>r+65&&g>b+55)mask[y*width+x]=1;
      }
      var boxes=new List<Tuple<int,int,int,int,int>>();var queue=new Queue<int>();
      for(int pos=0;pos<mask.Length;pos++){
        if(mask[pos]!=1)continue;mask[pos]=2;queue.Enqueue(pos);
        int left=width,top=height,right=0,bottom=0,count=0;
        while(queue.Count>0){int a=queue.Dequeue(),x=a%width,y=a/width;left=Math.Min(left,x);top=Math.Min(top,y);right=Math.Max(right,x);bottom=Math.Max(bottom,y);count++;
          int[] ns={x>0?a-1:-1,x<width-1?a+1:-1,y>0?a-width:-1,y<height-1?a+width:-1};
          foreach(int n in ns)if(n>=0&&mask[n]==1){mask[n]=2;queue.Enqueue(n);}
        }
        int w=right-left+1,h=bottom-top+1;
        if(w>=3&&w<=40&&h>=8&&h<=80&&count>=w*h*.4)boxes.Add(Tuple.Create(left,top,right,bottom,count));
      }
      boxes=MergeGlyphPieces(boxes);
      if(expectedSize>0)boxes=boxes.Where(b=>b.Item4-b.Item2+1>=expectedSize*.65&&b.Item4-b.Item2+1<=expectedSize*1.7&&b.Item3-b.Item1+1>=expectedSize*.3).ToList();
      var columns=new List<Tuple<int,int,int,int,int>[]>();
      foreach(var b in boxes){var column=boxes.Where(c=>Math.Abs(c.Item1-b.Item1)<=3).OrderBy(c=>c.Item2).ToArray();if(column.Length==specs.Length&&!columns.Any(c=>Math.Abs(c[0].Item1-column[0].Item1)<=3))columns.Add(column);}
      if(columns.Count!=1){Emit(new{type="probeDiagnostic",candidates=boxes.Select(b=>new{x=b.Item1,y=b.Item2,w=b.Item3-b.Item1+1,h=b.Item4-b.Item2+1}).ToArray(),columns=columns.Count,expected=specs.Length});return;}
      var chosen=columns[0];
      if(anchors.Count>0&&anchors.Values.Any(a=>Math.Abs(a.X-chosen[0].Item1)>3)){anchors.Clear();return;}
      for(int i=0;i<specs.Length;i++)anchors[Str(specs[i],"id")]=new Anchor{X=chosen[i].Item1,Y=(chosen[i].Item2+chosen[i].Item4)/2.0,Height=chosen[i].Item4-chosen[i].Item2+1};
    }
    static List<Tuple<int,int,int,int,int>> MergeGlyphPieces(List<Tuple<int,int,int,int,int>> input){
      var boxes=new List<Tuple<int,int,int,int,int>>(input);bool merged;
      do{
        merged=false;
        for(int i=0;i<boxes.Count&&!merged;i++)for(int j=i+1;j<boxes.Count;j++){
          var a=boxes[i];var b=boxes[j];
          int left=Math.Min(a.Item1,b.Item1),top=Math.Min(a.Item2,b.Item2),right=Math.Max(a.Item3,b.Item3),bottom=Math.Max(a.Item4,b.Item4);
          // Foreground code glyphs can split the zero-width marker into disconnected
          // pieces. Overlapping bounding boxes still belong to one rectangular mark.
          bool overlaps=a.Item1<=b.Item3&&b.Item1<=a.Item3&&a.Item2<=b.Item4&&b.Item2<=a.Item4;
          if(!overlaps||right-left+1>40||bottom-top+1>80)continue;
          boxes[i]=Tuple.Create(left,top,right,bottom,a.Item5+b.Item5);boxes.RemoveAt(j);merged=true;break;
        }
      }while(merged);
      return boxes;
    }
    static void GeometryTest(){
      var pieces=new List<Tuple<int,int,int,int,int>>{
        Tuple.Create(100,100,113,128,300),Tuple.Create(100,200,113,214,130),Tuple.Create(100,207,113,228,170),
        Tuple.Create(100,300,113,328,300),Tuple.Create(104,313,108,320,30),Tuple.Create(100,400,113,428,300)};
      var result=MergeGlyphPieces(pieces);
      bool ok=result.Count==4&&result.Any(b=>b.Item2==200&&b.Item4==228);
      Console.WriteLine(new JavaScriptSerializer().Serialize(new{type="geometryTest",passed=ok,pieces=pieces.Count,glyphs=result.Count}));
      Environment.ExitCode=ok?0:1;
    }
    void Play(IDictionary<string,object> data){
      if(Str(data,"style")=="hybrid"){Clear();Append(data);return;}
      bool nextCards=Str(data,"style")=="cards";
      var departing=new List<Ghost>();
      if(nextCards&&cardsMode)foreach(var old in jobs.Where(j=>j.LastP>0&&j.LastP<.96).Take(28))departing.Add(new Ghost{Text=old.Text,Color=colors[old.Worker%colors.Length],X=old.LastX,Y=old.LastY,W=old.LastW,H=old.LastH,At=watch.Elapsed.TotalSeconds});
      Clear();formatted.Clear();cardsMode=nextCards;modeName=nextCards?"cards":"cues";ghosts.AddRange(departing);if(!allowed||!Bind()||anchors.Count==0)return;
      var nowClient=Win.Client(owner);if(nowClient.Width!=client.Width||nowClient.Height!=client.Height)return;
      pointerSize=Math.Max(6,Math.Min(16,Num(data,"pointerSize",12)));zoom=Math.Max(.5,Math.Min(3,Num(data,"zoom",1)));lineHeight=Math.Max(10,Math.Min(100,Num(data,"lineHeight",21)));
      double[] workers=new double[Math.Max(1,Math.Min(50,(int)Num(data,"workers",32)))];
      double speed=Math.Max(.5,Math.Min(4,Num(data,"speed",4))),charWidth=Num(data,"charWidth",8);
      foreach(var item in Items(data,"tasks").Take(100)){
        Anchor anchor;if(!anchors.TryGetValue(Str(item,"anchor"),out anchor))continue;
        var worker=Array.IndexOf(workers,workers.Min());double start=workers[worker]+(cardsMode?(worker%16)*.012:(worker%8)*.035);
        string kind=Str(item,"kind","replace");double end=start+(cardsMode?(4.7+(jobs.Count%5)*.11+Math.Min(.6,Str(item,"text").Length/100.0))/speed:(kind=="move"?3.4:2.5)+Math.Min(1,Str(item,"text").Length/180.0));
        double w=Math.Max(35,Math.Min(330,Num(item,"width",150))),h=Math.Max(lineHeight,Math.Min(lineHeight*4,Num(item,"height",lineHeight)));
        Anchor from;bool hasFrom=anchors.TryGetValue(Str(item,"fromAnchor"),out from);
        jobs.Add(new Job{Index=jobs.Count,Variant=unchecked((int)Str(item,"text").GetHashCode()+jobs.Count)%5,Line=(int)Num(item,"line"),Kind=kind,Text=Str(item,"text"),Worker=worker,Start=start,End=end,X=anchor.X+(cardsMode?Num(item,"column")*charWidth:0),Y=anchor.Y,
          FromX=hasFrom?from.X:anchor.X+Math.Min(160,client.Width-anchor.X-40),FromY=hasFrom?from.Y:Math.Max(35,anchor.Y-65),Width=w,Height=h});workers[worker]=end;
      }
      started=watch.Elapsed.TotalSeconds;maxActive=0;
      if(cardsMode&&jobs.Count>0)LayoutCards(data,workers.Length);
      pulse.Interval=TimeSpan.FromMilliseconds(16);
      if(jobs.Count>0){Reposition();Show();surface.InvalidateVisual();Emit(new{type="playing",requestId=Str(data,"requestId"),tasks=jobs.Count,pointerSize=pointerSize});}
    }
    bool ImportGeometry(IDictionary<string,object> data){
      if(!allowed||!Bind())return false;
      var r=Win.Client(owner);uint dpi=Win.GetDpiForWindow(owner);
      if(Math.Abs(r.Width-Num(data,"width"))>1||Math.Abs(r.Height-Num(data,"height"))>1||Math.Abs(dpi/96.0-Num(data,"dpi",1))>.01)return false;
      client=r;probeDpi=dpi;anchors.Clear();
      foreach(var p in Items(data,"points").Take(200)){
        double x=Num(p,"x",-1),y=Num(p,"y",-1);
        if(!double.IsNaN(x)&&!double.IsNaN(y)&&x>=0&&y>=0&&x<r.Width&&y<r.Height)anchors[Str(p,"id")]=new Anchor{X=x,Y=y,Height=Num(p,"height",14)};
      }
      return anchors.Count>0;
    }
    void Append(IDictionary<string,object> data){
      if(!ImportGeometry(data)){Emit(new{type="layoutRequired",requestId=Str(data,"requestId")});return;}
      double now=watch.Elapsed.TotalSeconds;
      if(modeName!="hybrid"){Clear();started=now;}
      if(jobs.Count==0)started=now;
      modeName="hybrid";cardsMode=true;holding=false;
      double t=now-started; jobs.RemoveAll(j=>j.End<=t);
      bool preview=data.ContainsKey("preview")&&Convert.ToBoolean(data["preview"]);
      if(!preview)foreach(var j in jobs.Where(j=>j.Incoming))j.End=Math.Min(j.End,t+.2);
      pointerSize=Math.Max(6,Math.Min(16,Num(data,"pointerSize",12)));
      lineHeight=Math.Max(10,Math.Min(100,Num(data,"lineHeight",21)));sourceFontSize=Math.Max(8,Math.Min(80,Num(data,"fontSize",14)));
      int count=Math.Max(1,Math.Min(50,(int)Num(data,"workers",32)));
      double speed=Math.Max(.5,Math.Min(4,Num(data,"speed",4))),cw=Num(data,"charWidth",8);
      var added=new List<Job>();
      foreach(var item in Items(data,"tasks").Take(96)){
        Anchor a;if(!anchors.TryGetValue(Str(item,"anchor"),out a))continue;
        string visual=Str(item,"visual","type"),key=Str(item,"key"),text=Str(item,"text");
        if(visual!="type"&&jobs.Any(j=>j.Key==key&&j.End>t))continue;
        var previous=jobs.FirstOrDefault(j=>visual=="type"&&j.Visual=="type"&&j.Key==key);
        if(previous!=null){
          // Continue from the rendered caret; incoming chunks extend its destination.
          double target=a.X+Num(item,"column")*cw+Num(item,"width",30);
          previous.X=previous.CursorX>0?previous.CursorX:previous.X;
          previous.Width=Math.Max(cw,target-previous.X);previous.Y=a.Y;previous.End=t+.9;previous.Text=text;typeMerges++;continue;
        }
        if(jobs.Count>=96){var victim=jobs.OrderBy(j=>j.End).First();jobs.Remove(victim);droppedJobs++;}
        int worker=Enumerable.Range(0,count).OrderBy(w=>jobs.Count(j=>j.Worker==w&&j.End>t)).First();
        double start=t+(visual=="card"?(worker%16)*.008:0),duration=visual=="card"?Math.Max(.65,4.7/speed):visual=="erase"?.85:.7;
        Anchor from;bool hasFrom=anchors.TryGetValue(Str(item,"fromAnchor"),out from);
        var job=new Job{Index=appendedBatches*96+added.Count,Key=key,Visual=visual,Incoming=preview,Begin=Num(item,"begin"),Span=Num(item,"span",1),Variant=((Str(item,"text").GetHashCode()^(int)Num(item,"line"))&0x7FFFFFFF)%5,OldText=Str(item,"oldText"),Kind=Str(item,"kind"),Text=text,Line=(int)Num(item,"line"),Worker=worker,Start=start,End=start+duration,
          X=a.X+Num(item,"column")*cw,Y=a.Y,FromX=hasFrom?from.X:a.X,FromY=hasFrom?from.Y:a.Y,Width=Math.Max(cw,Num(item,"width",80)),Height=lineHeight};
        job.CursorX=job.X;job.LastTick=now; jobs.Add(job);added.Add(job);
      }
      // Only new cards receive a staging position; existing trajectories remain intact.
      var saved=jobs.Where(j=>!added.Contains(j)).ToDictionary(j=>j,j=>new[]{j.SX,j.SY,j.CardW,j.CardH});
      LayoutCards(data,count);
      jobs.RemoveAll(j=>!j.Incoming&&(j.Y/VisualDpi()<sceneTop-lineHeight/VisualDpi()||j.Y/VisualDpi()>sceneBottom+lineHeight/VisualDpi()));
      foreach(var entry in saved){entry.Key.SX=entry.Value[0];entry.Key.SY=entry.Value[1];entry.Key.CardW=entry.Value[2];entry.Key.CardH=entry.Value[3];}
      foreach(var j in added.Where(j=>j.Kind=="move"&&j.Visual=="card")){j.SX=j.FromX/VisualDpi();j.SY=j.FromY/VisualDpi();}
      appendedBatches++;pulse.Interval=TimeSpan.FromMilliseconds(16);
      if(jobs.Count>0){Reposition();Show();surface.InvalidateVisual();}
      if(Str(data,"type")!="perform")Emit(new{type=Str(data,"type")=="play"?"playing":"appended",requestId=Str(data,"requestId"),tasks=jobs.Count,pointerSize=pointerSize});
    }
    void Perform(IDictionary<string,object> data){
      var previous=new HashSet<Job>(jobs);double at=watch.Elapsed.TotalSeconds-started;
      foreach(var old in jobs){
        old.Controlled=false;
        if(old.Visual!="card")old.End=Math.Min(old.End,at+.22);
      }
      Append(data);var added=jobs.Where(j=>!previous.Contains(j)).ToArray();
      if(added.Length==0){Emit(new{type="notVisible",requestId=Str(data,"requestId")});return;}
      double duration=Math.Max(.2,Math.Min(1.5,Num(data,"duration",.4)));
      at=watch.Elapsed.TotalSeconds-started;
      foreach(var j in added){
        j.Controlled=j.Visual!="card";
        j.Steps=Math.Max(1,Math.Min(8,(int)Num(data,"steps",1)));
        j.Start=at;
        j.End=at+(j.Visual=="card"?Math.Max(duration,1.05):duration);
      }
      var ticket=added.FirstOrDefault(j=>j.Visual!="card")??added[0];
      ticket.Ticket=Str(data,"requestId");
    }
    void AdvanceAct(Job j,double p){
      if(j.Ticket==null||!IsVisible||Win.GetForegroundWindow()!=owner)return;
      int step=j.Steps==1?(p>=.78?1:0):(int)Math.Floor(Clamp((p-.18)/.6)*j.Steps);
      if(step<=j.SentStep)return;j.SentStep=step;actSignals++;
      Emit(new{type="actProgress",ticket=j.Ticket,step=step});
      if(step>=j.Steps){performedActs++;Emit(new{type="performed",requestId=j.Ticket});j.Ticket=null;}
    }
    void Shift(IDictionary<string,object> data){
      int start=(int)Num(data,"start"),end=(int)Num(data,"end"),delta=(int)Num(data,"delta");double t=watch.Elapsed.TotalSeconds-started;
      foreach(var j in jobs.Where(j=>!j.Incoming)){if(j.Line>end){j.Line+=delta;j.Y+=delta*lineHeight;j.Key=j.Visual+":"+j.Line+":";}else if(end>start&&j.Line>start)j.End=Math.Min(j.End,t+.15);}
    }
    void Reposition(){client=Win.Client(owner);Win.SetWindowPos(handle,new IntPtr(-1),client.Left,client.Top,client.Width,client.Height,0x10|0x40);}
    void Tick(object sender,EventArgs e){
      if(measuring)return;
      ghosts.RemoveAll(g=>watch.Elapsed.TotalSeconds-g.At>.65);
      if(jobs.Count==0){if(IsVisible)Hide();pulse.Interval=TimeSpan.FromMilliseconds(500);return;}
      if(!allowed||!Win.IsWindow(owner)||Win.IsIconic(owner)||Win.GetForegroundWindow()!=owner){Clear("notForeground");return;}
      if((Win.GetAsyncKeyState(0x11)&0x8000)!=0||(Win.GetAsyncKeyState(0x12)&0x8000)!=0){Clear("shortcut");return;}
      var r=Win.Client(owner);
      if(r.Width!=client.Width||r.Height!=client.Height||(!selfTest&&Win.GetDpiForWindow(owner)!=probeDpi)){Clear("layout");Emit(new{type="invalidated",reason="layout"});return;}
      if(r.Left!=client.Left||r.Top!=client.Top)Reposition();
      double t=watch.Elapsed.TotalSeconds-started;
      if(holding){if(watch.Elapsed.TotalSeconds-holdAt>1.5){Clear();return;}surface.InvalidateVisual();return;}
      int active=jobs.Count(j=>t>=j.Start&&t<j.End);maxActive=Math.Max(maxActive,active);
      if(jobs.All(j=>t>=j.End)&&!jobs.Any(j=>j.Ticket!=null)){Clear();Emit(new{type="idle",visiblePointers=0,maxActive=maxActive});return;}
      surface.InvalidateVisual();
    }
    static double Clamp(double v){return Math.Max(0,Math.Min(1,v));}
    static double Ease(double v){v=Clamp(v);return v*v*(3-2*v);}
    static double Lerp(double a,double b,double p){return a+(b-a)*p;}
    static SolidColorBrush Brush(string color,double opacity=1){
      opacity=Math.Round(Clamp(opacity)*40)/40;string key=color+"/"+opacity.ToString(CultureInfo.InvariantCulture);SolidColorBrush b;
      if(brushes.TryGetValue(key,out b))return b;
      if(brushes.Count>4096)brushes.Clear();b=new SolidColorBrush((Color)ColorConverter.ConvertFromString(color));b.Opacity=opacity;b.Freeze();brushes[key]=b;return b;
    }
    FormattedText Format(string text,double size,Brush brush,double width=0){
      double dpi=VisualTreeHelper.GetDpi(this).PixelsPerDip;width=width>0?Math.Round(width/2)*2:0;
      string key=text+"|"+size+"|"+brush.ToString()+"|"+width+"|"+dpi;FormattedText f;
      if(formatted.TryGetValue(key,out f))return f;
      if(formatted.Count>2048)formatted.Clear();
      f=new FormattedText(text,CultureInfo.InvariantCulture,FlowDirection.LeftToRight,new Typeface("Consolas"),size,brush,dpi);
      if(width>0){f.MaxTextWidth=Math.Max(12,width);f.Trimming=TextTrimming.CharacterEllipsis;f.MaxLineCount=1;}
      formatted[key]=f;return f;
    }
    void Text(DrawingContext dc,string text,double x,double y,Brush brush,double size){
      var f=Format(text,size,brush);
      dc.DrawText(f,new Point(x,y));
    }
    void Paint(DrawingContext dc){
      paintedLastFrame=0;
      if(jobs.Count==0||!allowed)return;
      double dpi=1;var source=PresentationSource.FromVisual(this);if(source!=null&&source.CompositionTarget!=null)dpi=source.CompositionTarget.TransformToDevice.M11;
      dc.PushClip(new RectangleGeometry(new Rect(0,0,ActualWidth,ActualHeight)));
      double t=watch.Elapsed.TotalSeconds-started;
      if(cardsMode){PaintCards(dc,dpi,t);dc.Pop();return;}
      foreach(var j in jobs){
        if(t<j.Start||t>=j.End)continue; // Idle and completed workers draw nothing.
        double p=Clamp((t-j.Start)/(j.End-j.Start)),fade=Ease(p/.1)*(1-Ease((p-.88)/.12));
        double tx=j.X/dpi,ty=j.Y/dpi,w=j.Width/dpi,h=j.Height/dpi,lh=lineHeight/dpi;
        string color=colors[j.Worker%colors.Length];var solid=Brush(color);
        double x=Lerp(tx+55,tx,Ease(p/.25)),y=Lerp(ty-30,ty,Ease(p/.25));
        dc.PushOpacity(fade);
        if(j.Kind!="delete"&&p>.18&&p<.85){
          double selected=Ease((p-.18)/.22);var rectangle=new Rect(tx-2,ty-lh*.48,w*selected,h);
          dc.DrawRoundedRectangle(Brush(color,.09),new Pen(Brush(color,.6),.7),rectangle,2,2);
        }
        if(j.Kind=="move"){
          var travel=Ease((p-.3)/.46);x=Lerp(j.FromX/dpi,tx,travel);y=Lerp(j.FromY/dpi,ty,travel)-Math.Sin(travel*Math.PI)*32;
          if(p>.25&&p<.86){
            string[] snippet=j.Text.Replace("\r","").Split('\n').Take(3).ToArray();double cardW=Math.Min(290,Math.Max(90,w));
            dc.DrawRoundedRectangle(Brush("#171E28",.93),new Pen(Brush(color,.8),.8),new Rect(Math.Max(0,x),Math.Max(0,y+12),cardW,Math.Min(72,12+snippet.Length*15)),4,4);
            for(int k=0;k<snippet.Length;k++)Text(dc,snippet[k].Length>40?snippet[k].Substring(0,40):snippet[k],Math.Max(0,x)+7,Math.Max(0,y+12)+5+k*15,Brush("#D8E4EE"),10);
            dc.DrawLine(new Pen(Brush(color,.7),1),new Point(tx,ty+lh*.5),new Point(tx+w,ty+lh*.5));
          }
        }else if(j.Kind=="insert"||j.Kind=="replace"){
          double typed=Ease((p-.32)/.48);x=tx+w*typed;y=ty+Math.Min(h-lh,Math.Floor(typed*Math.Max(1,h/lh)) * lh);
          if(p>.28){dc.DrawLine(new Pen(solid,1),new Point(x,y-lh*.45),new Point(x,y+lh*.45));}
        }else{
          // Deleted content no longer exists in the native editor. Strike only a ghost
          // snippet, never the unrelated live text which now occupies its old position.
          string old=j.Text.Replace("\r","").Split('\n').FirstOrDefault()??"";if(old.Length>34)old=old.Substring(0,34);
          double cardX=Math.Max(0,tx+35),cardY=Math.Max(0,ty-25),cardW=Math.Max(70,Math.Min(245,old.Length*6+14));
          dc.DrawRoundedRectangle(Brush("#231B23",.94),new Pen(Brush("#FA8BA6",.6),.7),new Rect(cardX,cardY,cardW,25),3,3);
          Text(dc,old,cardX+6,cardY+6,Brush("#E0B8C0"),10);
          double removed=Ease((p-.2)/.4);dc.DrawLine(new Pen(Brush("#FA8BA6",.9),1),new Point(cardX+5,cardY+13),new Point(cardX+5+(cardW-10)*removed,cardY+13));x=cardX+5+(cardW-10)*removed;y=cardY+13;
        }
        // Compact 10 DIP cursor by default; no name badges and no idle parking rows.
        var path=new StreamGeometry();using(var c=path.Open()){c.BeginFigure(new Point(x,y),true,true);c.PolyLineTo(new[]{new Point(x,y+pointerSize),new Point(x+pointerSize*.27,y+pointerSize*.69),new Point(x+pointerSize*.49,y+pointerSize*1.05),new Point(x+pointerSize*.65,y+pointerSize*.96),new Point(x+pointerSize*.43,y+pointerSize*.59),new Point(x+pointerSize*.81,y+pointerSize*.55)},true,false);}
        dc.DrawGeometry(solid,new Pen(Brush("#10151C",.85),.6),path);
        dc.Pop();
      }
      dc.Pop();
    }
    double VisualDpi(){var s=PresentationSource.FromVisual(this);return s!=null&&s.CompositionTarget!=null?s.CompositionTarget.TransformToDevice.M11:1;}
    void LayoutCards(IDictionary<string,object> data,int workers){
      double dpi=VisualDpi();Anchor top,bottom;
      bool hasTop=anchors.TryGetValue(Str(data,"topAnchor"),out top),hasBottom=anchors.TryGetValue(Str(data,"bottomAnchor"),out bottom);
      sceneLeft=14;
      sceneRight=Math.Max(sceneLeft+220,client.Width/dpi-26);
      sceneTop=14;
      sceneBottom=Math.Max(sceneTop+180,client.Height/dpi-34);
      foreach(var job in jobs){
        uint seed;unchecked{seed=2166136261;foreach(char c in job.Text)seed=(seed^c)*16777619;seed^=(uint)(job.Line*397+job.Index*31);}
        uint vertical;unchecked{vertical=seed*2246822519u+(uint)job.Index*3266489917u;}
        job.CardW=Math.Max(84,Math.Min(260,job.Text.Length*6.2+24));job.CardH=job.Variant==0?43:25;
        double tx=job.X/dpi,ty=job.Y/dpi;
        job.SX=sceneLeft+5+(seed%(uint)Math.Max(1,(int)(sceneRight-sceneLeft-job.CardW-10)));
        job.SY=sceneTop+5+(vertical%(uint)Math.Max(1,(int)(sceneBottom-sceneTop-job.CardH-10)));
        int side=(job.SX<tx?0:1)+(job.SY<ty?2:0);
        originSides.Add(side);
      }
    }
    static Point Cubic(Point a,Point b,Point c,Point d,double t){double q=1-t;return new Point(q*q*q*a.X+3*q*q*t*b.X+3*q*t*t*c.X+t*t*t*d.X,q*q*q*a.Y+3*q*q*t*b.Y+3*q*t*t*c.Y+t*t*t*d.Y);}
    string ActionLabel(string kind){return kind=="delete"?"DELETE":kind=="move"?"MOVE":kind=="replace"?"REPLACE":"BUILD";}
    void Card(DrawingContext dc,string text,string label,double x,double y,double w,double h,string color,double opacity,double angle=0,double reveal=1,int variant=0){
      if(w<10||h<10||opacity<=0)return;
      dc.PushOpacity(Clamp(opacity));dc.PushTransform(new RotateTransform(angle,x+w*.5,y+h*.5));
      if(variant!=0){
        if(variant%2==1){dc.DrawRoundedRectangle(Brush("#121B26",.93),new Pen(Brush(color,.85),.7),new Rect(x,y,w,h),h*.4,h*.4);dc.DrawEllipse(Brush(color),null,new Point(x+7,y+h*.5),1.7,1.7);}
        else{dc.DrawRectangle(Brush("#14202A",.88),null,new Rect(x,y,w,h));dc.DrawLine(new Pen(Brush(color),2),new Point(x,y),new Point(x,y+h));dc.DrawLine(new Pen(Brush(color,.65),.8),new Point(x,y+h),new Point(x+w,y+h));}
        dc.PushClip(new RectangleGeometry(new Rect(x+12,y,Math.Max(1,(w-16)*Clamp(reveal)),h)));
        Text(dc,text.Replace("\n"," "),x+13,y+Math.Max(2,(h-13)*.5),Brush("#DAE6F1"),10);dc.Pop();dc.Pop();dc.Pop();return;
      }
      dc.DrawRoundedRectangle(Brush("#000000",.25),null,new Rect(x+3,y+5,w,h),4,4);
      dc.DrawRoundedRectangle(Brush("#141D28",.97),new Pen(Brush(color,.9),.8),new Rect(x,y,w,h),4,4);
      dc.DrawRoundedRectangle(Brush(color,.12),null,new Rect(x+1,y+1,w-2,12),3,3);
      dc.DrawEllipse(Brush(color,.9),null,new Point(x+7,y+7),1.6,1.6);
      Text(dc,label,x+13,y+2,Brush(color,.95),7);
      dc.DrawLine(new Pen(Brush(color,.3),.5),new Point(x+5,y+14),new Point(x+w-5,y+14));
      dc.PushClip(new RectangleGeometry(new Rect(x+6,y+16,Math.Max(1,(w-12)*Clamp(reveal)),Math.Max(1,h-18))));
      var f=Format(text.Replace("\n"," "),9,Brush("#DAE6F1"),Math.Max(12,w-12));
      dc.DrawText(f,new Point(x+7,y+18));dc.Pop();dc.Pop();dc.Pop();
    }
    void Pointer(DrawingContext dc,double x,double y,string color,double alpha){
      dc.PushOpacity(Clamp(alpha));var path=new StreamGeometry();using(var c=path.Open()){c.BeginFigure(new Point(x,y),true,true);c.PolyLineTo(new[]{new Point(x,y+pointerSize),new Point(x+pointerSize*.27,y+pointerSize*.69),new Point(x+pointerSize*.49,y+pointerSize*1.05),new Point(x+pointerSize*.65,y+pointerSize*.96),new Point(x+pointerSize*.43,y+pointerSize*.59),new Point(x+pointerSize*.81,y+pointerSize*.55)},true,false);}
      dc.DrawGeometry(Brush(color),new Pen(Brush("#07111B",.95),.7),path);dc.Pop();
    }
    void PaintCards(DrawingContext dc,double dpi,double time){
      double now=watch.Elapsed.TotalSeconds;
      bool awaiting=jobs.Any(j=>j.Ticket!=null);
      dc.PushClip(new RectangleGeometry(new Rect(sceneLeft-10,sceneTop-10,Math.Max(20,sceneRight-sceneLeft+20),Math.Max(20,sceneBottom-sceneTop+20))));
      foreach(var ghost in ghosts){double p=Clamp((now-ghost.At)/.65);Card(dc,ghost.Text,"NEXT",ghost.X+Math.Sin(p*Math.PI)*18,ghost.Y-p*28,ghost.W,ghost.H,ghost.Color,(1-p)*.65,-p*4);}
      foreach(var j in jobs){
        if(modeName=="hybrid"&&j.Visual!="card")continue;
        if(!j.Incoming&&(j.Y/dpi<sceneTop-lineHeight/dpi||j.Y/dpi>sceneBottom+lineHeight/dpi))continue;
        if(holding&&(j.LastP<=0||j.LastP>=1))continue;
        if(!holding&&(time<j.Start-.42||time>=j.End&&!(j.Controlled&&awaiting)))continue;
        double p=Clamp((time-j.Start)/(j.End-j.Start));if(j.Controlled&&awaiting)p=Math.Min(.82,p);
        double alpha=Ease((time-j.Start+.42)/.38)*(1-Ease((p-.88)/.12));
        AdvanceAct(j,p);
        if(alpha>.05){paintedLastFrame++;seenMotions.Add("card");}
        string workerColor=colors[j.Worker%colors.Length];
        string color=j.Kind=="delete"?"#FF879B":j.Kind=="move"?"#B59AFF":j.Kind=="replace"?"#72D8E6":workerColor;double x,y,w=j.CardW,h=j.CardH,angle=0;
        double tx=Math.Max(sceneLeft,Math.Min(sceneRight-50,j.X/dpi)),ty=Math.Max(sceneTop,Math.Min(sceneBottom-20,j.Y/dpi-lineHeight/dpi*.45));
        if(j.Kind=="delete"){tx=sceneRight-80;ty=sceneTop+15;}
        uint bendSeed;unchecked{bendSeed=2166136261;foreach(char c in j.Text)bendSeed=(bendSeed^c)*16777619;bendSeed^=(uint)(j.Line*397+j.Index*31);}
        double travel=Ease((p-.2)/.58),bendX=(int)(bendSeed/17%181)-90,bendY=(int)(bendSeed/53%181)-90;
        Point source=new Point(j.SX,j.SY),target=new Point(tx,ty);
        var position=Cubic(source,new Point(source.X+bendX,source.Y+bendY),new Point(target.X-bendX,target.Y-bendY),target,travel);
        x=position.X;y=position.Y;angle=Math.Sin(travel*Math.PI)*(j.Index%2==0?4:-4);
        if(p<.2){x+=Math.Sin(time*2+j.Index)*3;y+=Math.Cos(time*2+j.Index)*2;}
        if(holding){
          double f=Clamp((now-holdAt)/1.5);x=Lerp(j.LastX,j.SX, Ease(f*.8))+Math.Sin(now*2+j.Index)*3;y=Lerp(j.LastY,j.SY,Ease(f*.8))-Math.Sin(f*Math.PI)*12;
          alpha=(1-Ease((f-.45)/.55))*.8;angle=Math.Sin(now+j.Index)*2;
        }else if(p>.73){
          if(j.Kind=="delete"){double shrink=1-Ease((p-.73)/.2);w*=shrink;h*=shrink;}
          else{w=Lerp(w,Math.Max(45,Math.Min(j.Width/dpi,sceneRight-tx)),Ease((p-.73)/.18));h=Lerp(h,Math.Max(22,lineHeight/dpi),Ease((p-.73)/.18));}
        }
        j.LastX=x;j.LastY=y;j.LastW=w;j.LastH=h;j.LastP=holding?Math.Min(j.LastP,.8):p;
        if(!holding&&p>.2&&p<.82){
          var guide=new StreamGeometry();using(var c=guide.Open()){c.BeginFigure(source,false,false);c.BezierTo(new Point(source.X+bendX,source.Y+bendY),new Point(target.X-bendX,target.Y-bendY),target,true,false);}
          var pen=new Pen(Brush(color,.19),.7){DashStyle=new DashStyle(new[]{2.0,5.0},0)};dc.DrawGeometry(null,pen,guide);
          dc.DrawLine(new Pen(Brush(color,.3),.7),new Point(tx,ty+lineHeight/dpi),new Point(Math.Min(sceneRight,tx+Math.Max(40,j.Width/dpi)),ty+lineHeight/dpi));
        }
        Card(dc,j.Text,"L"+(j.Line+1)+" / "+ActionLabel(j.Kind),x,y,w,h,color,alpha,angle,Ease((p+.05)/.2),j.Variant);
        if(j.Kind=="delete"&&!holding&&p>.55){double q=Ease((p-.55)/.25);dc.DrawLine(new Pen(Brush("#FF879B",alpha),1.1),new Point(x+6,y+25),new Point(x+6+(w-12)*q,y+25));}
        if(time>=j.Start||holding){
          double approach=Ease(p/.18);double px=Lerp(j.SX+40,x+7,approach),py=Lerp(j.SY-24,y+2,approach);
          Pointer(dc,px,py,workerColor,alpha);
          if(!holding&&p>.77){double q=Clamp((p-.77)/.2),r=4+q*18;dc.DrawEllipse(null,new Pen(Brush(color,(1-q)*alpha*.7),1),new Point(tx+8,ty+5),r,r);
            for(int k=0;k<5;k++){double a=k*Math.PI*2/5+j.Index;dc.DrawEllipse(Brush(color,(1-q)*alpha*.8),null,new Point(tx+8+Math.Cos(a)*r,ty+5+Math.Sin(a)*r),1.1,1.1);}}
        }
      }
      if(modeName=="hybrid")PaintHybridCues(dc,dpi,time);
      dc.Pop();
    }
    void PaintHybridCues(DrawingContext dc,double dpi,double time){
      bool awaiting=jobs.Any(j=>j.Ticket!=null);
      foreach(var j in jobs){
        if(j.Visual=="card"||time<j.Start||time>=j.End&&!(j.Controlled&&awaiting))continue;
        if(j.Y/dpi<sceneTop-lineHeight/dpi||j.Y/dpi>sceneBottom+lineHeight/dpi)continue;
        double p=Clamp((time-j.Start)/(j.End-j.Start));if(j.Controlled&&awaiting)p=Math.Min(.82,p);
        double alpha=1-Ease((p-.72)/.28),x=j.X/dpi,y=j.Y/dpi,lh=lineHeight/dpi;
        AdvanceAct(j,p);
        double actFraction=j.Controlled?Math.Floor(Clamp((p-.18)/.6)*j.Steps)/j.Steps:0;
        if(j.Controlled&&j.Visual=="type"&&(actFraction<j.Begin||actFraction>j.Begin+j.Span+.1))continue;
        paintedLastFrame++;seenMotions.Add(j.Visual);
        x=Math.Max(sceneLeft,Math.Min(sceneRight-35,x));
        double w=Math.Max(6,Math.Min(j.Width/dpi,sceneRight-x)),travel=Ease(p/.72),px=x+w*travel;
        if(j.Controlled&&j.Visual=="trace"){travel=actFraction;px=x+w*travel;}
        string color=j.Visual=="erase"?"#FF879B":colors[j.Worker%colors.Length];
        if(j.Visual=="outline"){
          double q=Ease(p/.35),edge=x+w*q,baseY=y-lh*.47;
          dc.DrawRectangle(Brush(color,.06*alpha),new Pen(Brush(color,.8*alpha),.75),new Rect(x,baseY,Math.Max(1,w*q),lh));
          foreach(double corner in new[]{x,edge})foreach(double cy in new[]{baseY,baseY+lh})dc.DrawRectangle(Brush("#111B26",alpha),new Pen(Brush(color,alpha),.8),new Rect(corner-2,cy-2,4,4));
          dc.DrawLine(new Pen(Brush(color,alpha),.9),new Point(edge-5,baseY+lh-5),new Point(edge+5,baseY+lh+5));
          dc.DrawLine(new Pen(Brush(color,alpha),.9),new Point(edge-5,baseY+lh+5),new Point(edge+5,baseY+lh-5));
          if(p>.22)CodeGhost(dc,j.Text,x,baseY,sourceFontSize/dpi,alpha*(j.Incoming?.95:.45),j.Controlled?Clamp((actFraction-.25)/.75):Ease((p-.22)/.5),w);
          Pointer(dc,edge,baseY+lh,color,alpha);
        }else if(j.Visual=="stamp"){
          double q=Ease(p/.7),sy=Math.Max(sceneTop,y-lh*(1.5+j.Variant*.3)),sx=Math.Min(sceneRight-50,x+40+j.Variant*12);
          double cx=Lerp(sx,x,q),cy=Lerp(sy,y-lh*.45,q)-Math.Sin(q*Math.PI)*12;
          dc.DrawLine(new Pen(Brush("#FF879B",alpha*.5),.7),new Point(x-7,sy),new Point(x-7,y));
          Card(dc,j.Text,"COPY",cx,cy,Math.Min(190,w+20),lh+6,color,alpha,Math.Sin(q*Math.PI)*2,1,1);
          Text(dc,"+",cx+6,cy-7,Brush(color,alpha),12);Pointer(dc,cx+10,cy+4,color,alpha);
        }else if(j.Visual=="trace"){
          CodeGhost(dc,j.Text,x,y-lh*.45,sourceFontSize/dpi,alpha*(j.Incoming?.95:.5),travel,w);
          dc.DrawLine(new Pen(Brush(color,alpha*.8),1.5),new Point(x,y+lh*.47),new Point(px,y+lh*.47));
          dc.DrawEllipse(null,new Pen(Brush(color,alpha*.6),.8),new Point(px,y),3+p*8,3+p*8);
          for(int k=0;k<4;k++)dc.DrawEllipse(Brush(color,alpha*(1-k*.2)),null,new Point(px-k*6,y+Math.Sin(p*10+k)*4),1.2,1.2);
          Pointer(dc,px,y-lh*.3,color,alpha);
        }else if(j.Visual=="erase"){
          // Deleted source is a plain red ghost. No floating box or live-text strike.
          string old=string.IsNullOrEmpty(j.OldText)?j.Text:j.OldText;
          var f=Format(old,sourceFontSize/dpi,Brush(color,alpha*.9),Math.Max(10,w));
          double ghostY=y-lh*.75;
          dc.PushClip(new RectangleGeometry(new Rect(px,ghostY,Math.Max(1,w*(1-travel)),lh*1.4)));
          dc.DrawText(f,new Point(x,ghostY));dc.Pop();
          dc.DrawLine(new Pen(Brush(color,alpha*.9),1.4),new Point(px,ghostY+2),new Point(px,ghostY+lh));
          for(int k=0;k<5;k++){double phase=(p*3+k*.19)%1;dc.DrawEllipse(Brush(color,alpha*(1-phase)),null,new Point(px-phase*20,y+Math.Sin(k*2.4+p*7)*8),1.1,1.1);}
          Pointer(dc,px,ghostY+lh*.5,color,alpha);
        }else if(j.Visual=="edit"){
          double selection=Ease(p/.3),fade=1-Ease((p-.35)/.4);
          dc.DrawRectangle(Brush(color,.2*alpha*fade),null,new Rect(x,y-lh*.48,Math.Max(1,w*selection),lh));
          dc.DrawLine(new Pen(Brush(color,alpha*.9),1.1),new Point(x,y+lh*.43),new Point(x+w*travel,y+lh*.43));
          if(p<.5&&!string.IsNullOrEmpty(j.OldText)){
            dc.PushOpacity(alpha*(1-p*2)*.7);Text(dc,j.OldText,x,y-lh*1.3,Brush("#FF879B"),Math.Max(8,sourceFontSize/dpi*.8));dc.Pop();
          }
          Pointer(dc,x+w*selection,y-lh*.45,color,alpha);
        }else{
          // Pursue the latest destination at frame cadence. New chunks extend the
          // deadline without resetting easing to zero on every incoming update.
          double at=watch.Elapsed.TotalSeconds,dt=Math.Max(0,Math.Min(.08,at-j.LastTick));j.LastTick=at;
          double goal=Math.Min(sceneRight-10,(j.X+j.Width)/dpi),origin=Math.Min(sceneRight-42,x);
          double before=Math.Max(sceneLeft,Math.Min(sceneRight-10,j.CursorX/dpi));
          px=j.Controlled?Lerp(x,Math.Max(sceneLeft,goal),Clamp((actFraction-j.Begin)/Math.Max(.001,j.Span))):Lerp(before,Math.Max(sceneLeft,goal),1-Math.Exp(-dt/.085));
          typingDistance+=Math.Abs(px-before);typingFrames++;j.CursorX=px*dpi;
          x=origin;alpha=j.Controlled&&awaiting?1:Clamp((j.End-time)/.22);
          if(j.Incoming)CodeGhost(dc,j.Text,x,y-lh*.45,sourceFontSize/dpi,alpha*.95,Clamp((px-x)/Math.Max(1,w)),w);
          dc.DrawRectangle(Brush(color,.14*alpha),null,new Rect(Math.Max(x,px-32),y-lh*.45,Math.Max(1,Math.Min(32,px-x)),lh));
          dc.DrawLine(new Pen(Brush(color,alpha),1.8),new Point(px,y-lh*.43),new Point(px,y+lh*.4));
          dc.DrawLine(new Pen(Brush(color,.65*alpha),1),new Point(Math.Max(x,px-46),y+lh*.44),new Point(px,y+lh*.44));
          for(int k=0;k<3;k++)dc.DrawEllipse(Brush(color,alpha*(.6-k*.15)),null,new Point(px-5-k*7,y+Math.Sin(time*9+k)*3),.9,.9);
          Pointer(dc,px+2,y-lh*.38,color,alpha);
        }
      }
    }
    void CodeGhost(DrawingContext dc,string text,double x,double y,double size,double alpha,double reveal,double width){
      CodeToken[] tokens;
      if(!tokenized.TryGetValue(text,out tokens)){
        bool comment=text.TrimStart().StartsWith("#");
        tokens=Regex.Matches(text,@"\s+|[A-Za-z_]\w*|\d+(?:\.\d+)?|[\uD800-\uDBFF][\uDC00-\uDFFF]|.").Cast<Match>().Select(token=>new CodeToken{Text=token.Value,Color=comment?"#86B996":Regex.IsMatch(token.Value,@"^\d")?"#E6C07B":keywords.Contains(token.Value)?"#B59AFF":"#D4E7F4"}).ToArray();
        if(tokenized.Count>=512)tokenized.Clear();tokenized[text]=tokens;
      }
      dc.PushOpacity(Clamp(alpha));
      dc.PushClip(new RectangleGeometry(new Rect(x,y,Math.Max(1,width*Clamp(reveal)),size*1.6)));
      double at=x;
      foreach(var token in tokens){
        var glyph=Format(token.Text,size,Brush(token.Color));dc.DrawText(glyph,new Point(at,y));at+=glyph.WidthIncludingTrailingWhitespace;
        if(at>x+width)break;
      }
      dc.Pop();dc.Pop();
    }
    void Report(string id){double t=watch.Elapsed.TotalSeconds-started;int active=holding?jobs.Count(j=>j.LastP>0&&j.LastP<1):jobs.Count(j=>t>=j.Start&&t<j.End);Emit(new{type="status",requestId=id,visible=IsVisible,visiblePointers=active,visibleCards=cardsMode?(holding?active:jobs.Count(j=>(modeName!="hybrid"||j.Visual=="card")&&t>=j.Start-.42&&t<j.End)):0,styleName=modeName,visuals=jobs.GroupBy(j=>j.Visual??"card").ToDictionary(g=>g.Key,g=>g.Count()),appendedBatches=appendedBatches,typeMerges=typeMerges,performedActs=performedActs,actSignals=actSignals,painted=paintedLastFrame,seenMotions=seenMotions.ToArray(),originSides=originSides.ToArray(),typingFrames=typingFrames,typingDistance=typingDistance,droppedJobs=droppedJobs,holding=holding,ghosts=ghosts.Count,jobs=jobs.Count,sceneDuration=jobs.Count>0?jobs.Max(j=>j.End):0,maxActive=maxActive,pointerSize=pointerSize,owner=owner.ToInt64(),title=Win.Title(owner),style=Win.GetWindowLong(handle,-20),left=client.Left,top=client.Top,width=client.Width,height=client.Height,actualWidth=ActualWidth,actualHeight=ActualHeight});}
    void BeginSelfTest(){
      testWindow=new Window{Title="Code Swarm overlay test target",Width=900,Height=620,Left=120,Top=120,Background=Brush("#151C26"),Content=new System.Windows.Controls.TextBox{Text="Click-through test target",FontSize=20,Margin=new Thickness(40)}};
      testWindow.Show();testWindow.Activate();owner=new WindowInteropHelper(testWindow).Handle;client=Win.Client(owner);
      anchors["a"]=new Anchor{X=120,Y=120,Height=16};
      Command(new Dictionary<string,object>{{"type","play"},{"tasks",new object[]{new Dictionary<string,object>{{"anchor","a"},{"kind","move"},{"text","def hello():\n    return 42"}}}}});
      if(inspection)foreach(var job in jobs)job.End=20;
      var verify=new DispatcherTimer{Interval=TimeSpan.FromMilliseconds(800)};
      verify.Tick+=(s,e)=>{
        verify.Stop();var at=new Win.POINT{X=client.Left+130,Y=client.Top+130};
        bool clickThrough=Win.GetAncestor(Win.WindowFromPoint(at),2)==owner;
        bool focusSafe=Win.GetForegroundWindow()==owner;
        Emit(new{type="selfTest",clickThrough=clickThrough,focusSafe=focusSafe,pointerSize=pointerSize,style=Win.GetWindowLong(handle,-20)});
      };verify.Start();
      if(!inspection){
        var move=new DispatcherTimer{Interval=TimeSpan.FromMilliseconds(1200)};move.Tick+=(s,e)=>{move.Stop();testWindow.Left+=40;testWindow.Top+=20;};move.Start();
        var checkMove=new DispatcherTimer{Interval=TimeSpan.FromMilliseconds(1600)};checkMove.Tick+=(s,e)=>{checkMove.Stop();var r=Win.Client(owner);Emit(new{type="selfTestMove",tracksMove=client.Left==r.Left&&client.Top==r.Top});testWindow.Width-=40;};checkMove.Start();
        var checkSize=new DispatcherTimer{Interval=TimeSpan.FromMilliseconds(2100)};checkSize.Tick+=(s,e)=>{checkSize.Stop();Emit(new{type="selfTestResize",canceled=!IsVisible&&jobs.Count==0});};checkSize.Start();
      }
      var end=new DispatcherTimer{Interval=TimeSpan.FromSeconds(inspection?25:6)};end.Tick+=(s,e)=>{end.Stop();Emit(new{type="selfTestIdle",visible=IsVisible,pointers=jobs.Count});testWindow.Close();Close();};end.Start();
    }
    [STAThread] public static void Main(string[] args){
      Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=new UTF8Encoding(false);
      if(args.Contains("--test-geometry")){GeometryTest();return;}
      try{Win.SetProcessDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){}
      var app=new Application{ShutdownMode=ShutdownMode.OnExplicitShutdown};var window=new Overlay(args.Contains("--self-test"),args.Contains("--inspect"));app.Run(window);
    }
  }
}

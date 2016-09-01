from django.shortcuts import render

def index(request):
    return render(request, 'webui/index.html', {})

def activity(request):
    return render(request, 'webui/activity.html', {})

def activity2(request):
    return render(request, 'webui/activity2.html', {})
